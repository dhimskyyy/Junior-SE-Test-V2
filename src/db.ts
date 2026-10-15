import Database from 'better-sqlite3';
import {
  Subscription,
  WebhookEvent,
  DeliveryAttempt,
  EventStatus,
  SubscriptionStatus,
} from './types.js';
import crypto from 'node:crypto';

export class WebhookStore {
  private db: Database.Database;

  constructor(dbPath: string = 'webhooks.db') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL UNIQUE,
        endpoint_url TEXT NOT NULL,
        secret TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS customer_sequences (
        customer_id TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        last_error TEXT,
        FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_events_poll 
        ON events(status, next_attempt_at);

      CREATE INDEX IF NOT EXISTS idx_events_customer 
        ON events(customer_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS delivery_attempts (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        status_code INTEGER,
        response_body TEXT,
        error_message TEXT,
        duration_ms INTEGER NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_delivery_attempts_event 
        ON delivery_attempts(event_id, started_at ASC);
    `);
  }

  // --- Subscriptions ---

  upsertSubscription(
    customerId: string,
    endpointUrl: string,
    secret: string
  ): Subscription {
    const existing = this.getSubscriptionByCustomerId(customerId);
    const now = Date.now();

    if (existing) {
      const stmt = this.db.prepare(`
        UPDATE subscriptions 
        SET endpoint_url = ?, secret = ?, consecutive_failures = 0, status = 'active'
        WHERE id = ?
      `);
      stmt.run(endpointUrl, secret, existing.id);
      return this.getSubscriptionById(existing.id)!;
    }

    const id = 'sub_' + crypto.randomUUID().slice(0, 12);
    const stmt = this.db.prepare(`
      INSERT INTO subscriptions (id, customer_id, endpoint_url, secret, consecutive_failures, status, created_at)
      VALUES (?, ?, ?, ?, 0, 'active', ?)
    `);
    stmt.run(id, customerId, endpointUrl, secret, now);
    return this.getSubscriptionById(id)!;
  }

  getSubscriptionById(id: string): Subscription | null {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
    return row ? (row as Subscription) : null;
  }

  getSubscriptionByCustomerId(customerId: string): Subscription | null {
    const row = this.db
      .prepare('SELECT * FROM subscriptions WHERE customer_id = ?')
      .get(customerId);
    return row ? (row as Subscription) : null;
  }

  listSubscriptions(): Subscription[] {
    return this.db.prepare('SELECT * FROM subscriptions ORDER BY created_at DESC').all() as Subscription[];
  }

  updateSubscriptionDegradedStatus(
    subscriptionId: string,
    consecutiveFailures: number,
    status: SubscriptionStatus
  ): void {
    this.db
      .prepare(
        'UPDATE subscriptions SET consecutive_failures = ?, status = ? WHERE id = ?'
      )
      .run(consecutiveFailures, status, subscriptionId);
  }

  // --- Events ---

  private nextSequence(customerId: string): number {
    const getSeq = this.db.prepare(
      'SELECT last_sequence FROM customer_sequences WHERE customer_id = ?'
    );
    const row = getSeq.get(customerId) as { last_sequence: number } | undefined;

    if (!row) {
      this.db
        .prepare('INSERT INTO customer_sequences (customer_id, last_sequence) VALUES (?, 1)')
        .run(customerId);
      return 1;
    }

    const next = row.last_sequence + 1;
    this.db
      .prepare('UPDATE customer_sequences SET last_sequence = ? WHERE customer_id = ?')
      .run(next, customerId);
    return next;
  }

  createEvent(
    customerId: string,
    subscriptionId: string,
    eventType: string,
    payload: Record<string, any>,
    maxAttempts: number = 5
  ): WebhookEvent {
    const transaction = this.db.transaction(() => {
      const seq = this.nextSequence(customerId);
      const id = 'evt_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const now = Date.now();

      const stmt = this.db.prepare(`
        INSERT INTO events (
          id, customer_id, subscription_id, event_type, payload,
          sequence_number, status, attempt_count, max_attempts,
          next_attempt_at, created_at, delivered_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL, NULL)
      `);

      stmt.run(
        id,
        customerId,
        subscriptionId,
        eventType,
        JSON.stringify(payload),
        seq,
        maxAttempts,
        now, // immediately eligible
        now
      );

      return this.getEventById(id)!;
    });

    return transaction();
  }

  getEventById(id: string): (WebhookEvent & { attempts: DeliveryAttempt[] }) | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as any;
    if (!row) return null;

    const attempts = this.db
      .prepare('SELECT * FROM delivery_attempts WHERE event_id = ? ORDER BY attempt_number ASC')
      .all(id) as DeliveryAttempt[];

    return {
      ...row,
      payload: JSON.parse(row.payload),
      attempts,
    };
  }

  listEvents(filters?: {
    customerId?: string;
    status?: EventStatus;
    limit?: number;
    offset?: number;
  }): { events: WebhookEvent[]; total: number } {
    let whereClauses: string[] = [];
    let params: any[] = [];

    if (filters?.customerId) {
      whereClauses.push('customer_id = ?');
      params.push(filters.customerId);
    }

    if (filters?.status) {
      whereClauses.push('status = ?');
      params.push(filters.status);
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM events ${whereStr}`)
      .get(...params) as { total: number };

    const rows = this.db
      .prepare(`SELECT * FROM events ${whereStr} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as any[];

    const events = rows.map((r) => ({
      ...r,
      payload: JSON.parse(r.payload),
    }));

    return { events, total: countRow.total };
  }

  /**
   * Fetch due pending events for processing.
   * Excludes events for customers who currently have active in-flight requests exceeding limit,
   * to guarantee fair sharing across customers and avoid head-of-line blocking.
   */
  fetchDueEvents(
    maxBatch: number,
    excludedCustomerIds: string[] = []
  ): WebhookEvent[] {
    const now = Date.now();
    let query = `
      SELECT * FROM events 
      WHERE status = 'pending' AND next_attempt_at <= ?
    `;
    const params: any[] = [now];

    if (excludedCustomerIds.length > 0) {
      const placeholders = excludedCustomerIds.map(() => '?').join(',');
      query += ` AND customer_id NOT IN (${placeholders})`;
      params.push(...excludedCustomerIds);
    }

    query += ` ORDER BY next_attempt_at ASC, sequence_number ASC LIMIT ?`;
    params.push(maxBatch);

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((r) => ({
      ...r,
      payload: JSON.parse(r.payload),
    }));
  }

  /**
   * Mark event as currently processing (in-flight)
   */
  claimEventForProcessing(eventId: string): boolean {
    const res = this.db
      .prepare(`UPDATE events SET status = 'processing' WHERE id = ? AND status = 'pending'`)
      .run(eventId);
    return res.changes > 0;
  }

  /**
   * Records a completed delivery attempt and updates the event's lifecycle status.
   */
  recordAttempt(
    eventId: string,
    attempt: {
      attemptNumber: number;
      startedAt: number;
      finishedAt: number;
      statusCode: number | null;
      responseBody: string | null;
      errorMessage: string | null;
      durationMs: number;
    },
    nextStatus: EventStatus,
    nextAttemptAt: number | null,
    lastError: string | null
  ): void {
    const transaction = this.db.transaction(() => {
      const attemptId = 'att_' + crypto.randomUUID().slice(0, 16);
      this.db
        .prepare(`
          INSERT INTO delivery_attempts (
            id, event_id, attempt_number, started_at, finished_at,
            status_code, response_body, error_message, duration_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          attemptId,
          eventId,
          attempt.attemptNumber,
          attempt.startedAt,
          attempt.finishedAt,
          attempt.statusCode,
          attempt.responseBody,
          attempt.errorMessage,
          attempt.durationMs
        );

      const deliveredAt = nextStatus === 'delivered' ? attempt.finishedAt : null;

      this.db
        .prepare(`
          UPDATE events 
          SET status = ?,
              attempt_count = ?,
              next_attempt_at = COALESCE(?, next_attempt_at),
              delivered_at = COALESCE(?, delivered_at),
              last_error = ?
          WHERE id = ?
        `)
        .run(
          nextStatus,
          attempt.attemptNumber,
          nextAttemptAt,
          deliveredAt,
          lastError,
          eventId
        );
    });

    transaction();
  }

  /**
   * Replay / manually retry a failed or delivered event.
   */
  retryEvent(eventId: string): WebhookEvent | null {
    const now = Date.now();
    const res = this.db
      .prepare(`
        UPDATE events 
        SET status = 'pending',
            next_attempt_at = ?,
            attempt_count = 0,
            last_error = NULL
        WHERE id = ?
      `)
      .run(now, eventId);

    if (res.changes === 0) return null;
    return this.getEventById(eventId);
  }

  getStats(): {
    totalEvents: number;
    pending: number;
    processing: number;
    delivered: number;
    failed: number;
    subscriptions: number;
  } {
    const counts = this.db
      .prepare(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
          SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) as delivered,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM events
      `)
      .get() as any;

    const subCount = this.db
      .prepare('SELECT COUNT(*) as count FROM subscriptions')
      .get() as any;

    return {
      totalEvents: counts.total || 0,
      pending: counts.pending || 0,
      processing: counts.processing || 0,
      delivered: counts.delivered || 0,
      failed: counts.failed || 0,
      subscriptions: subCount.count || 0,
    };
  }

  close() {
    this.db.close();
  }
}
