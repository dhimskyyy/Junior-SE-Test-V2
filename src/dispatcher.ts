import { WebhookStore } from './db.js';
import {
  WebhookEvent,
  Subscription,
  RetryPolicy,
  EventStatus,
} from './types.js';
import { signPayload } from './crypto.js';

export interface DispatcherOptions {
  store: WebhookStore;
  policy?: Partial<RetryPolicy>;
  pollIntervalMs?: number;
  maxGlobalConcurrency?: number;
  maxConcurrentPerCustomer?: number;
  fetchFn?: typeof fetch;
}

export class WebhookDispatcher {
  private store: WebhookStore;
  private policy: RetryPolicy;
  private pollIntervalMs: number;
  private maxGlobalConcurrency: number;
  private maxConcurrentPerCustomer: number;
  private fetchFn: typeof fetch;

  private isRunning: boolean = false;
  private pollTimer: NodeJS.Timeout | null = null;

  // Track currently active in-flight deliveries
  private activeGlobalCount: number = 0;
  private activePerCustomer: Map<string, number> = new Map();

  constructor(options: DispatcherOptions) {
    this.store = options.store;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.maxGlobalConcurrency = options.maxGlobalConcurrency ?? 10;
    this.maxConcurrentPerCustomer = options.maxConcurrentPerCustomer ?? 2;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;

    this.policy = {
      maxAttempts: 5,
      initialDelayMs: 2000,   // 2s
      backoffFactor: 2,       // 2x exponential
      maxDelayMs: 60000,      // 60s max backoff
      jitterFactor: 0.2,      // +/- 20% jitter
      requestTimeoutMs: 5000, // 5s HTTP timeout
      ...options.policy,
    };
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.scheduleNextPoll(0);
  }

  stop() {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private scheduleNextPoll(delayMs: number = this.pollIntervalMs) {
    if (!this.isRunning) return;
    this.pollTimer = setTimeout(() => {
      this.pollAndDispatch().catch((err) => {
        console.error('[Dispatcher] Error in polling loop:', err);
      }).finally(() => {
        if (this.isRunning) {
          this.scheduleNextPoll();
        }
      });
    }, delayMs);
  }

  /**
   * Main dispatch loop: fetches ready events considering per-customer fair limits.
   */
  async pollAndDispatch() {
    const availableSlots = this.maxGlobalConcurrency - this.activeGlobalCount;
    if (availableSlots <= 0) {
      return; // All global workers busy
    }

    // Identify customers who have reached their concurrency limit
    const saturatedCustomers: string[] = [];
    for (const [custId, count] of this.activePerCustomer.entries()) {
      if (count >= this.maxConcurrentPerCustomer) {
        saturatedCustomers.push(custId);
      }
    }

    // Fetch batch of ready events excluding saturated customers
    const events = this.store.fetchDueEvents(availableSlots, saturatedCustomers);
    if (events.length === 0) {
      return;
    }

    for (const event of events) {
      // Re-verify slot availability
      const currentCustCount = this.activePerCustomer.get(event.customer_id) || 0;
      if (
        this.activeGlobalCount >= this.maxGlobalConcurrency ||
        currentCustCount >= this.maxConcurrentPerCustomer
      ) {
        continue;
      }

      // Atomically mark event as processing in database
      const claimed = this.store.claimEventForProcessing(event.id);
      if (!claimed) {
        continue;
      }

      // Increment concurrency counters
      this.activeGlobalCount++;
      this.activePerCustomer.set(event.customer_id, currentCustCount + 1);

      // Execute delivery asynchronously in background
      this.deliverEvent(event).finally(() => {
        this.activeGlobalCount--;
        const updated = (this.activePerCustomer.get(event.customer_id) || 1) - 1;
        if (updated <= 0) {
          this.activePerCustomer.delete(event.customer_id);
        } else {
          this.activePerCustomer.set(event.customer_id, updated);
        }
      });
    }
  }

  /**
   * Calculates exponential backoff with jitter.
   */
  calculateNextAttemptDelay(attemptNumber: number): number {
    const baseDelay =
      this.policy.initialDelayMs *
      Math.pow(this.policy.backoffFactor, attemptNumber - 1);
    const cappedDelay = Math.min(baseDelay, this.policy.maxDelayMs);

    // Apply full or equal jitter: delay * (1 - jitter ... 1 + jitter)
    const jitterRange = cappedDelay * this.policy.jitterFactor;
    const randomJitter = (Math.random() * 2 - 1) * jitterRange;
    return Math.max(100, Math.floor(cappedDelay + randomJitter));
  }

  /**
   * Executes HTTP POST delivery of a single event to the customer's registered endpoint.
   */
  private async deliverEvent(event: WebhookEvent): Promise<void> {
    const subscription = this.store.getSubscriptionById(event.subscription_id);
    if (!subscription) {
      this.store.recordAttempt(
        event.id,
        {
          attemptNumber: event.attempt_count + 1,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          statusCode: null,
          responseBody: null,
          errorMessage: `Subscription ${event.subscription_id} not found`,
          durationMs: 0,
        },
        'failed',
        null,
        'Subscription not found'
      );
      return;
    }

    const attemptNumber = event.attempt_count + 1;
    const payloadString = JSON.stringify(event.payload);
    const signature = signPayload(payloadString, subscription.secret);
    const timestamp = Date.now();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'WebhookDeliveryService/1.0',
      'X-Webhook-ID': event.id,
      'X-Webhook-Event': event.event_type,
      'X-Webhook-Timestamp': timestamp.toString(),
      'X-Webhook-Attempt': attemptNumber.toString(),
      'X-Webhook-Sequence': event.sequence_number.toString(),
      'X-Webhook-Signature': signature,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.policy.requestTimeoutMs);

    const startedAt = Date.now();
    let statusCode: number | null = null;
    let responseBody: string | null = null;
    let errorMessage: string | null = null;
    let isSuccess = false;

    try {
      const response = await this.fetchFn(subscription.endpoint_url, {
        method: 'POST',
        headers,
        body: payloadString,
        signal: controller.signal,
      });

      statusCode = response.status;
      try {
        const text = await response.text();
        responseBody = text.slice(0, 1024); // Cap preview to 1KB
      } catch {
        responseBody = '';
      }

      // We consider standard 2xx as successful delivery
      if (response.ok) {
        isSuccess = true;
      } else {
        errorMessage = `HTTP error status ${response.status}: ${response.statusText}`;
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        errorMessage = `Request timed out after ${this.policy.requestTimeoutMs}ms`;
      } else {
        errorMessage = `Network or connection failure: ${err.message}`;
      }
    } finally {
      clearTimeout(timeout);
    }

    const finishedAt = Date.now();
    const durationMs = finishedAt - startedAt;

    if (isSuccess) {
      // Successful delivery
      this.store.recordAttempt(
        event.id,
        {
          attemptNumber,
          startedAt,
          finishedAt,
          statusCode,
          responseBody,
          errorMessage: null,
          durationMs,
        },
        'delivered',
        null,
        null
      );

      // Reset customer degraded status if any
      if (subscription.consecutive_failures > 0) {
        this.store.updateSubscriptionDegradedStatus(
          subscription.id,
          0,
          'active'
        );
      }
    } else {
      // Delivery failed
      const consecutiveFailures = subscription.consecutive_failures + 1;
      const isDegraded = consecutiveFailures >= 3;

      this.store.updateSubscriptionDegradedStatus(
        subscription.id,
        consecutiveFailures,
        isDegraded ? 'degraded' : 'active'
      );

      if (attemptNumber >= event.max_attempts) {
        // Reached terminal failure state
        this.store.recordAttempt(
          event.id,
          {
            attemptNumber,
            startedAt,
            finishedAt,
            statusCode,
            responseBody,
            errorMessage,
            durationMs,
          },
          'failed',
          null,
          `Max attempts (${event.max_attempts}) exceeded. Last error: ${errorMessage}`
        );
      } else {
        // Schedule next retry with exponential backoff & jitter
        let delayMs = this.calculateNextAttemptDelay(attemptNumber);

        // If customer is severely degraded (long outage), add outage protection multiplier
        if (isDegraded) {
          delayMs = Math.min(delayMs * 1.5, this.policy.maxDelayMs);
        }

        const nextAttemptAt = Date.now() + delayMs;

        this.store.recordAttempt(
          event.id,
          {
            attemptNumber,
            startedAt,
            finishedAt,
            statusCode,
            responseBody,
            errorMessage,
            durationMs,
          },
          'pending',
          nextAttemptAt,
          errorMessage
        );
      }
    }
  }

  getMetrics() {
    return {
      activeGlobalCount: this.activeGlobalCount,
      maxGlobalConcurrency: this.maxGlobalConcurrency,
      activePerCustomer: Object.fromEntries(this.activePerCustomer.entries()),
      maxConcurrentPerCustomer: this.maxConcurrentPerCustomer,
      policy: this.policy,
    };
  }
}
