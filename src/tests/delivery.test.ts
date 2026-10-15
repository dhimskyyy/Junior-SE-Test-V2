import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../app.js';
import { verifySignature } from '../crypto.js';

describe('Webhook Delivery Service Integration Tests', () => {
  let store: any;
  let dispatcher: any;

  // Track mock requests
  let receivedRequests: Array<{
    url: string;
    headers: Record<string, string>;
    body: any;
  }> = [];

  let flakyAttempts = 0;

  // Hermetic mock fetch implementation for tests
  const mockFetch: typeof fetch = async (input, init) => {
    const url = input.toString();
    const headers = (init?.headers as Record<string, string>) || {};
    const body = init?.body ? JSON.parse(init.body as string) : null;

    if (url.includes('/target/success')) {
      receivedRequests.push({ url, headers, body });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/target/flaky')) {
      flakyAttempts++;
      if (flakyAttempts < 3) {
        return new Response(JSON.stringify({ error: 'Service Unavailable' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      } else {
        receivedRequests.push({ url, headers, body });
        return new Response(JSON.stringify({ ok: true, recovered: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (url.includes('/target/fail')) {
      return new Response(JSON.stringify({ error: 'Fatal error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  };

  before(() => {
    process.env.NODE_ENV = 'test';

    const created = createApp(':memory:', {
      pollIntervalMs: 50,
      fetchFn: mockFetch,
      policy: {
        maxAttempts: 3,
        initialDelayMs: 100, // fast retries for tests
        backoffFactor: 2,
        maxDelayMs: 1000,
        jitterFactor: 0.05,
        requestTimeoutMs: 1000,
      },
    });

    store = created.store;
    dispatcher = created.dispatcher;
    dispatcher.start();
  });

  after(() => {
    dispatcher.stop();
    store.close();
  });

  test('1. Register customer subscription and verify HMAC secret', () => {
    const sub = store.upsertSubscription(
      'cust_alpha',
      'https://api.customer-a.com/target/success',
      'secret_key_123'
    );

    assert.equal(sub.customer_id, 'cust_alpha');
    assert.equal(sub.endpoint_url, 'https://api.customer-a.com/target/success');
    assert.equal(sub.secret, 'secret_key_123');
    assert.equal(sub.status, 'active');
  });

  test('2. Successfully ingest and deliver event (Happy Path with Signature verification)', async () => {
    receivedRequests = [];

    const event = store.createEvent(
      'cust_alpha',
      store.getSubscriptionByCustomerId('cust_alpha').id,
      'order.created',
      { orderId: 101, amount: 250000 }
    );

    assert.equal(event.status, 'pending');
    assert.equal(event.sequence_number, 1);

    // Wait for dispatcher poll
    await new Promise((r) => setTimeout(r, 200));

    const updated = store.getEventById(event.id);
    assert.equal(updated.status, 'delivered');
    assert.equal(updated.attempt_count, 1);
    assert.ok(updated.delivered_at);
    assert.equal(updated.attempts.length, 1);
    assert.equal(updated.attempts[0].status_code, 200);

    // Verify received headers at mock endpoint
    assert.equal(receivedRequests.length, 1);
    const req = receivedRequests[0];
    assert.equal(req.headers['X-Webhook-ID'], event.id);
    assert.equal(req.headers['X-Webhook-Sequence'], '1');
    assert.equal(req.body.orderId, 101);

    // Verify HMAC SHA-256 signature
    const signature = req.headers['X-Webhook-Signature'];
    assert.ok(signature.startsWith('sha256='));
    const isValid = verifySignature(
      JSON.stringify(req.body),
      'secret_key_123',
      signature
    );
    assert.equal(isValid, true, 'HMAC signature should be valid');
  });

  test('3. Retry flaky endpoint with exponential backoff until success', async () => {
    flakyAttempts = 0;
    receivedRequests = [];

    store.upsertSubscription(
      'cust_flaky',
      'https://api.flaky-service.com/target/flaky',
      'secret_flaky'
    );

    const sub = store.getSubscriptionByCustomerId('cust_flaky');
    const event = store.createEvent('cust_flaky', sub.id, 'payment.pending', {
      invoiceId: 'inv_999',
    });

    // Wait for first attempt (flakyAttempts = 1, 503)
    await new Promise((r) => setTimeout(r, 80));
    let current = store.getEventById(event.id);
    assert.equal(current.status, 'pending');
    assert.equal(current.attempt_count, 1);
    assert.equal(current.attempts[0].status_code, 503);

    // Wait for retries (attempt 2 fails 503, attempt 3 succeeds 200)
    await new Promise((r) => setTimeout(r, 600));

    current = store.getEventById(event.id);
    assert.equal(current.status, 'delivered');
    assert.equal(current.attempt_count, 3);
    assert.equal(current.attempts.length, 3);
    assert.equal(current.attempts[2].status_code, 200);
  });

  test('4. Terminal failed state when endpoint never responds with 2xx', async () => {
    store.upsertSubscription(
      'cust_dead',
      'https://api.down-service.com/target/fail',
      'secret_dead'
    );

    const sub = store.getSubscriptionByCustomerId('cust_dead');
    const event = store.createEvent(
      'cust_dead',
      sub.id,
      'user.deleted',
      { userId: 444 },
      3 // max 3 attempts
    );

    // Wait for all 3 attempts to exhaust
    await new Promise((r) => setTimeout(r, 1200));

    const finalEvent = store.getEventById(event.id);
    assert.equal(finalEvent.status, 'failed');
    assert.equal(finalEvent.attempt_count, 3);
    assert.equal(finalEvent.attempts.length, 3);
    assert.ok(finalEvent.last_error.includes('Max attempts (3) exceeded'));
  });

  test('5. Dead-Letter replay: Manual retry of a failed event', async () => {
    // We update subscription to a working endpoint before retrying
    store.upsertSubscription(
      'cust_dead',
      'https://api.customer-a.com/target/success',
      'secret_dead'
    );

    const events = store.listEvents({ customerId: 'cust_dead', status: 'failed' });
    assert.ok(events.events.length > 0);
    const failedEvent = events.events[0];

    // Replay event
    const requeued = store.retryEvent(failedEvent.id);
    assert.equal(requeued.status, 'pending');
    assert.equal(requeued.attempt_count, 0);

    // Wait for delivery
    await new Promise((r) => setTimeout(r, 200));

    const delivered = store.getEventById(failedEvent.id);
    assert.equal(delivered.status, 'delivered');
  });

  test('6. Monotonic Sequence Numbering per customer', () => {
    const sub = store.getSubscriptionByCustomerId('cust_alpha');
    const e1 = store.createEvent('cust_alpha', sub.id, 'item.1', { n: 1 });
    const e2 = store.createEvent('cust_alpha', sub.id, 'item.2', { n: 2 });
    const e3 = store.createEvent('cust_alpha', sub.id, 'item.3', { n: 3 });

    assert.equal(e1.sequence_number, 2); // 1 was used in test 2
    assert.equal(e2.sequence_number, 3);
    assert.equal(e3.sequence_number, 4);
  });
});
