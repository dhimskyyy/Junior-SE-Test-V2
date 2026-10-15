import { WebhookStore } from './db.js';

const customers = [
  ['cust_healthy', '/webhook/success'],
  ['cust_slow', '/webhook/slow'],
  ['cust_failing_500', '/webhook/failing'],
  ['cust_fatal_404', '/webhook/fatal-404'],
  ['cust_flaky', '/webhook/flaky'],
] as const;

const dbPath = process.env.DB_PATH || 'webhooks.db';
const store = new WebhookStore(dbPath);

for (const [customerId, path] of customers) {
  store.upsertSubscription(
    customerId,
    `http://localhost:4000${path}`,
    `seed-secret-${customerId}`
  );
}

console.log(`Database initialized and ${customers.length} customer subscriptions seeded in ${dbPath}.`);
store.close();
