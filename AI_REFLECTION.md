# AI-Assisted Workflow & Engineering Reflection

This document reflects on the collaborative workflow between human engineer and AI assistant during the design, implementation, and verification of the Webhook Delivery Service.

---

### 1. Collaboration & Prompting Strategy
* **High-Level Architectural Alignment First:**
  Rather than jumping directly to generating boilerplate code, the workflow began with a deliberate brainstorming phase. We analyzed the assignment brief, extracted the four core architectural ambiguities (Delivery Semantics, Retry Backoff, Long Outages, and Ordering Guarantees), and aligned on the trade-offs before writing a single line of production code.
* **Separation of Concerns:**
  The system was designed modularly:
  - `src/types.ts`: Clean domain models and configuration interfaces.
  - `src/crypto.ts`: Security layer (HMAC SHA-256 signing and timing-safe verification).
  - `src/db.ts`: SQLite relational storage with WAL mode, transactions, and indexing.
  - `src/dispatcher.ts`: Concurrency-controlled fair queue and backoff scheduler.
  - `src/app.ts` & `src/api.ts`: Decoupled Express app and REST routing.
  - `src/server.ts`: Executable entrypoint with graceful shutdown handling.

---

### 2. Key Challenges & AI Troubleshooting Encountered
* **Challenge 1: Isolated Testing & Sandbox Environment:**
  - *Observation:* During automated testing, attempts to bind or connect to random TCP loopback sockets in restricted sandbox modes triggered network isolation `EPERM` errors.
  - *Engineering Solution:* Instead of forcing external network connections or hacky delays, we introduced **Dependency Injection for Network Transport** (`fetchFn?: typeof fetch` in `DispatcherOptions`).
  - *Benefit:* This made unit and integration tests completely hermetic, zero-dependency, and execution time dropped to ~2 seconds without port collisions. In production, it defaults seamlessly to Node's native `globalThis.fetch`.
* **Challenge 2: Module Evaluation Side-Effects in ES Modules:**
  - *Observation:* Importing the app factory in test and demo scripts caused the standalone HTTP listener to fire prematurely due to top-level code execution in `server.ts`.
  - *Engineering Solution:* Decoupled the Express app creation factory into `src/app.ts`, keeping `src/server.ts` purely as the runnable binary entrypoint.

---

### 3. Key Learnings
1. **AI as a Pair Programmer & Sounding Board:** AI excels at synthesizing trade-off analyses (e.g. strict ordering vs throughput under failure scenarios), rapidly generating boilerplate, and crafting exhaustive edge-case test suites.
2. **Human Judgment is Essential:** Deciding *what not to build* (resisting over-engineering like deploying Kafka or Kubernetes for a ~3h challenge) and designing clear failure states (dead-lettering instead of silent drop) requires sound engineering judgment.
