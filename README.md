# Reliable Webhook Delivery Service

A robust, fault-tolerant webhook delivery service built with **TypeScript**, **Node.js**, and **SQLite**. It reliably ingests events from internal producers and guarantees delivery to customer HTTP endpoints with exponential backoff, per-customer concurrency isolation, dead-letter recovery, and cryptographic HMAC SHA-256 payload signing.

---

## ⚡ Quick Start (One-Line Run Command)

```bash
npm start
```
*The service will start on `http://localhost:3000` with an embedded SQLite datastore (`webhooks.db`).*

---

## 🧪 Quick Verification & Demos

| Command | Description |
| :--- | :--- |
| **`npm run demo`** | **Recommended!** Runs the interactive end-to-end demonstration showcasing healthy delivery, retries, terminal failure, and dead-letter replay. |
| **`npm test`** | Executes the automated test suite (`src/tests/delivery.test.ts`) covering all failure cases. |
| **`npm run mock`** | Starts the mock customer receiver server on `http://localhost:4000` (success, flaky, slow, down endpoints). |

---

## 🏗️ Architecture Overview

```mermaid
flowchart LR
    Producer["Internal Producer"] -->|POST /api/events| API["Express REST API"]
    API -->|Atomic Insert| DB[(SQLite WAL Mode)]
    Scheduler["Dispatcher Loop"] -->|Poll Due Events| DB
    Scheduler -->|Fair Concurrency Filter| Worker["Delivery Worker Pool"]
    Worker -->|POST with HMAC Signature| Customer["Customer Endpoint"]
    Customer -.->|HTTP 2xx (Success)| Delivered["Mark Delivered"]
    Customer -.->|HTTP 5xx / Timeout (Fail)| Retry["Exponential Backoff + Jitter"]
    Retry -->|Max Attempts Reached| DLQ["Mark FAILED (Dead-Letter)"]
```

### Key Architectural Highlights:
1. **At-Least-Once Delivery:** Events are safely stored in SQLite before acknowledgement. Each delivery includes `X-Webhook-ID`, `X-Webhook-Timestamp`, and `X-Webhook-Sequence` headers so customers can implement idempotent processing.
2. **Exponential Backoff with Jitter:** Configurable retry delays with randomized jitter to prevent the thundering herd problem.
3. **Fair Queuing & Outage Protection:** Limits concurrent requests per customer (`maxConcurrentPerCustomer = 2`) to prevent Head-of-Line blocking. An outage on Customer A never starves Customer B.
4. **Dead-Letter Queue & Manual Replay:** Unrecoverable events transition to `failed` and can be inspected or re-delivered via `POST /api/events/:id/retry`.

---

## 📁 Repository Structure

```
.
├── DECISIONS.md             # In-depth justification of 4 core design decisions
├── AI_REFLECTION.md         # Reflection on AI-assisted workflow and learnings
├── Junior SE Test V2.pdf    # Original assignment prompt
├── package.json             # NPM scripts and dependencies
├── tsconfig.json            # TypeScript configuration
└── src/
    ├── types.ts             # Domain models and configuration interfaces
    ├── crypto.ts            # HMAC SHA-256 signing and verification helpers
    ├── db.ts                # SQLite database repository and queries
    ├── dispatcher.ts        # Concurrency-controlled fair queue & retry engine
    ├── api.ts               # Express API router (subscriptions & events)
    ├── app.ts               # Express application factory
    ├── server.ts            # Main runnable server entrypoint
    ├── mock-customer.ts     # Mock customer receiver server
    ├── demo.ts              # End-to-end live demonstration script
    └── tests/
        └── delivery.test.ts # Automated integration test suite
```

---

## 📡 API Reference & Examples

### 1. Register a Customer Webhook Endpoint
```bash
curl -X POST http://localhost:3000/api/subscriptions \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "cust_123",
    "endpointUrl": "http://localhost:4000/webhook/success"
  }'
```

### 2. Ingest an Event (Internal Producer)
```bash
curl -X POST http://localhost:3000/api/events \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "cust_123",
    "eventType": "order.completed",
    "payload": {
      "orderId": "ORD-999",
      "amount": 250000,
      "currency": "IDR"
    }
  }'
```

### 3. Check Event Delivery Status & Attempt History
```bash
curl http://localhost:3000/api/events/evt_YOUR_EVENT_ID
```

### 4. Manually Replay a Failed Event
```bash
curl -X POST http://localhost:3000/api/events/evt_YOUR_EVENT_ID/retry
```

### 5. Check Service Health & Metrics
```bash
curl http://localhost:3000/api/health
```

---

## 📄 Submission Documents
* [DECISIONS.md](DECISIONS.md) - Analysis of Delivery Semantics, Retry Behavior, Long Outages, and Ordering.
* [AI_REFLECTION.md](AI_REFLECTION.md) - AI-assisted workflow, prompting strategy, and challenges.
