export type EventStatus = 'pending' | 'processing' | 'delivered' | 'failed';

export type SubscriptionStatus = 'active' | 'degraded';

export interface Subscription {
  id: string;
  customer_id: string;
  endpoint_url: string;
  secret: string;
  consecutive_failures: number;
  status: SubscriptionStatus;
  created_at: number; // Unix ms
}

export interface WebhookEvent {
  id: string;
  customer_id: string;
  subscription_id: string;
  event_type: string;
  payload: Record<string, any>;
  sequence_number: number;
  status: EventStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: number; // Unix ms
  created_at: number;      // Unix ms
  delivered_at: number | null;
  last_error: string | null;
}

export interface DeliveryAttempt {
  id: string;
  event_id: string;
  attempt_number: number;
  started_at: number;
  finished_at: number;
  status_code: number | null;
  response_body: string | null;
  error_message: string | null;
  duration_ms: number;
}

export interface CreateSubscriptionInput {
  customerId: string;
  endpointUrl: string;
  secret?: string;
}

export interface IngestEventInput {
  customerId: string;
  eventType?: string;
  payload: Record<string, any>;
}

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  backoffFactor: number;
  maxDelayMs: number;
  jitterFactor: number; // 0.0 - 1.0
  requestTimeoutMs: number;
}
