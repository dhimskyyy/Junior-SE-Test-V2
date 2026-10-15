# Architectural Decisions & Trade-Offs

This document addresses the four core design decisions outlined in the assignment brief, along with justifications and deliberate exclusions.

---

### 1. Delivery Semantics: At-Least-Once Delivery
* **Decision:** We offer **at-least-once** delivery guarantees.
* **Why not Exactly-Once?** Over unreliable IP networks, true exactly-once delivery is provably impossible without distributed two-phase commits (which HTTP webhooks do not support). If an endpoint processes a webhook but drops the network connection before returning `HTTP 200`, the delivery service has no choice but to retry, resulting in a duplicate delivery.
* **Why not At-Most-Once?** In webhook systems (e.g., payment confirmations, order status changes), dropping an event due to a transient network blip is unacceptable (*zero data loss* requirement).
* **Demand on Customer:** The customer **must implement idempotent processing** on their receiving endpoint. To facilitate this:
  - We transmit a unique event identifier in both headers (`X-Webhook-ID`) and payload (`id`).
  - We transmit an increasing sequence number (`X-Webhook-Sequence`) and timestamp (`X-Webhook-Timestamp`).
  - We provide HMAC SHA-256 signatures (`X-Webhook-Signature`) to prevent replay/tampering attacks.

---

### 2. Retry Behavior & Terminal Failure State
* **Algorithm:** Exponential backoff with full jitter:
  $$\text{delay} = \min\left(\text{maxDelay}, \text{initialDelay} \times 2^{\text{attempt} - 1}\right) \pm \text{jitter}$$
  - Default: Base `2s`, multiplier `2x`, capped at `60s`, with $\pm 20\%$ jitter.
  - Jitter prevents the "thundering herd" problem where hundreds of retries simultaneously hit a recovering customer server.
* **Max Attempts:** 5 attempts.
* **Terminal State (Dead-Letter):** If the customer endpoint fails to return a 2xx response after 5 attempts, the event transitions to the terminal status **`failed`**.
* **Audit & Recovery:** We never drop failed events silently. Every attempt is recorded in the `delivery_attempts` table (timestamp, status code, response body preview, duration, error message). Operators or automated jobs can trigger manual replays via `POST /api/events/:id/retry`.

---

### 3. Long Outages (Customer Endpoint Down for 6+ Hours)
* **Problem (Head-of-Line Blocking):** If Customer A is completely down or hanging with long timeouts (e.g. 5–10s), their failing events must not monopolize worker threads or delay deliveries for Customer B and C.
* **Mitigation Strategies:**
  1. **Fair Concurrency Limiter:** We enforce per-customer concurrency caps (`maxConcurrentPerCustomer = 2`, `maxGlobalConcurrency = 10`). Even if Customer A has hundreds of pending/retrying events, they can only occupy at most 2 worker slots. The remaining 8 slots remain instantly available for healthy customers.
  2. **Circuit Breaker / Degraded State:** If a customer's endpoint fails 3 consecutive times, the subscription is marked `degraded`. Future retries and events for this customer receive an extended backoff penalty ($1.5\times$ delay multiplier), preventing unnecessary load on the customer's failing infrastructure.
  3. **Non-Blocking Persistence:** All events are stored in SQLite with indexed timestamps (`next_attempt_at`). Sleeping retries consume zero CPU or thread memory.

---

### 4. Event Ordering: Relaxed Ordering with Monotonic Sequence
* **Decision:** We implement **relaxed ordering** by default, with monotonic per-customer sequence numbers (`sequence_number`).
* **Why not Strict FIFO?** Strict head-of-line ordering means that if Event #1 fails and enters a 30-minute backoff cycle, Event #2 (which might be completely unrelated) is forced to wait 30 minutes. This creates massive pipeline latency and poor resilience.
* **Ordering Guarantee:** 
  - Each customer is assigned an atomic, monotonically increasing sequence number per event.
  - Receivers who require strict ordering can inspect `X-Webhook-Sequence` and buffer out-of-order deliveries.

---

### 5. Deliberate Exclusions (Out of Scope)
In accordance with the assignment guidelines to cap time at ~3 hours:
* **No Authentication / Multi-Tenant Billing:** The service focuses purely on the ingestion, scheduling, and reliable delivery layer.
* **No Frontend UI:** Operations and inspection are fully exposed via clean REST endpoints and a live terminal demonstration script (`npm run demo`).
* **Embedded Datastore:** We chose SQLite in WAL mode instead of hosting an external Redis/PostgreSQL cluster. SQLite is zero-dependency, crash-resilient, transactional, and runs out-of-the-box on any machine.
