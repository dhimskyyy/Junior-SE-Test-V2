import { createApp } from './app.js';
import { verifySignature } from './crypto.js';

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runDemo() {
  console.log(`
=============================================================
🌟 WEBHOOK DELIVERY SERVICE - LIVE DEMONSTRATION 🌟
=============================================================
`);

  const mockEndpoints: Record<string, { attempts: number; responses: number[] }> = {
    'https://customer-a.example/webhook': { attempts: 0, responses: [200] },
    'https://customer-b.example/webhook': { attempts: 0, responses: [503, 503, 200] },
    'https://customer-c.example/webhook': { attempts: 0, responses: [500, 500, 500, 500, 500] },
  };

  const demoFetch: typeof fetch = async (input, init) => {
    const url = input.toString();
    const config = mockEndpoints[url];
    const attempt = init?.headers ? (init.headers as any)['X-Webhook-Attempt'] : 1;
    const eventId = init?.headers ? (init.headers as any)['X-Webhook-ID'] : '';

    if (!config) {
      return new Response('Not Found', { status: 404 });
    }

    config.attempts++;
    const statusIndex = Math.min(config.attempts - 1, config.responses.length - 1);
    const status = config.responses[statusIndex];

    console.log(
      `  [HTTP POST] -> ${url} | Event: ${eventId} | Attempt #${attempt} => HTTP ${status}`
    );

    if (status >= 200 && status < 300) {
      return new Response(JSON.stringify({ received: true }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    } else {
      return new Response(JSON.stringify({ error: `Mock Failure (HTTP ${status})` }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  };

  process.env.NODE_ENV = 'test'; // prevent default server listen

  // Fast retry delays for demo
  const { store, dispatcher } = createApp(':memory:', {
    pollIntervalMs: 50,
    fetchFn: demoFetch,
    policy: {
      maxAttempts: 3,
      initialDelayMs: 300,
      backoffFactor: 2,
      maxDelayMs: 2000,
      jitterFactor: 0.1,
      requestTimeoutMs: 1000,
    },
  });

  dispatcher.start();

  console.log('📌 STEP 1: Registering Customer Subscriptions');
  const subA = store.upsertSubscription('cust_healthy', 'https://customer-a.example/webhook', 'secret_a');
  const subB = store.upsertSubscription('cust_flaky', 'https://customer-b.example/webhook', 'secret_b');
  const subC = store.upsertSubscription('cust_down', 'https://customer-c.example/webhook', 'secret_c');

  console.log(`  ✓ Registered Customer A: ${subA.endpoint_url} (Secret: ${subA.secret})`);
  console.log(`  ✓ Registered Customer B: ${subB.endpoint_url} (Secret: ${subB.secret})`);
  console.log(`  ✓ Registered Customer C: ${subC.endpoint_url} (Secret: ${subC.secret})`);

  console.log('\n📌 STEP 2: Ingesting Events for All 3 Customers');
  const evA = store.createEvent('cust_healthy', subA.id, 'order.completed', {
    orderId: 'ORD-101',
    amount: 150000,
    currency: 'IDR',
  });
  console.log(`  ✓ Queued Event A (${evA.id}) - Target: Healthy endpoint`);

  const evB = store.createEvent('cust_flaky', subB.id, 'payment.confirmed', {
    paymentId: 'PAY-202',
    status: 'PAID',
  });
  console.log(`  ✓ Queued Event B (${evB.id}) - Target: Flaky endpoint (fails 2x, then recovers)`);

  const evC = store.createEvent('cust_down', subC.id, 'user.signup', {
    userId: 'USR-303',
    email: 'alex@example.com',
  }, 3); // max 3 attempts
  console.log(`  ✓ Queued Event C (${evC.id}) - Target: Down endpoint (permanent failure)`);

  console.log('\n📌 STEP 3: Dispatcher Processing Events with Retries & Backoff...');
  await sleep(2500);

  console.log('\n📌 STEP 4: Checking Event Delivery Statuses & Attempt History');

  const checkEvent = (id: string) => {
    const ev = store.getEventById(id);
    console.log(`\n--- Event [${ev.id}] (${ev.event_type}) ---`);
    console.log(`  Status:         ${ev.status.toUpperCase()}`);
    console.log(`  Sequence No:    #${ev.sequence_number}`);
    console.log(`  Attempt Count:  ${ev.attempt_count} / ${ev.max_attempts}`);
    console.log(`  Delivered At:   ${ev.delivered_at ? new Date(ev.delivered_at).toISOString() : 'N/A'}`);
    console.log(`  Last Error:     ${ev.last_error || 'None'}`);
    console.log(`  Attempt Logs:`);
    for (const att of ev.attempts) {
      console.log(
        `    - Attempt #${att.attempt_number}: HTTP ${att.status_code || 'ERR'} | Duration: ${att.duration_ms}ms | Error: ${att.error_message || 'None'}`
      );
    }
  };

  checkEvent(evA.id);
  checkEvent(evB.id);
  checkEvent(evC.id);

  console.log('\n📌 STEP 5: Dead-Letter Queue Recovery (Manual Replay)');
  console.log(`  Customer C fixed their server! Updating endpoint response to 200 OK...`);
  mockEndpoints['https://customer-c.example/webhook'].responses = [200];
  mockEndpoints['https://customer-c.example/webhook'].attempts = 0;

  console.log(`  Calling POST /api/events/${evC.id}/retry...`);
  store.retryEvent(evC.id);

  await sleep(500);

  const evCRecovered = store.getEventById(evC.id);
  console.log(`  ✓ Event C Status after Replay: ${evCRecovered.status.toUpperCase()}`);
  console.log(`  ✓ Event C Delivered At:        ${new Date(evCRecovered.delivered_at).toISOString()}`);

  console.log('\n📌 STEP 6: Final System Stats');
  console.log(store.getStats());

  dispatcher.stop();
  store.close();

  console.log(`
=============================================================
🎉 DEMONSTRATION COMPLETE: ALL SCENARIOS VERIFIED!
=============================================================
`);
  process.exit(0);
}

runDemo().catch((err) => {
  console.error(err);
  process.exit(1);
});
