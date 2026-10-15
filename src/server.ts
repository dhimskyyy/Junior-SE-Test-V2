import { createApp } from './app.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const DB_PATH = process.env.DB_PATH || 'webhooks.db';

const { app, store, dispatcher } = createApp({ dbPath: DB_PATH });

dispatcher.start();

const server = app.listen(PORT, () => {
  console.log(`
=============================================================
🚀 Webhook Delivery Service is running on http://localhost:${PORT}
💾 SQLite Database: ${DB_PATH}
⚡ Dispatcher started: Exponential backoff with fair queueing
=============================================================
Endpoints:
  POST /api/subscriptions  - Register customer endpoint
  POST /api/events         - Publish event to customer
  GET  /api/events/:id     - Inspect event & delivery attempt history
  GET  /api/health         - View queue stats & worker metrics
=============================================================
`);
});

// Graceful shutdown handling
let isShuttingDown = false;
const shutdown = () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\nShutting down gracefully...');
  dispatcher.stop();

  if (typeof server.closeAllConnections === 'function') {
    server.closeAllConnections();
  }

  server.close(() => {
    store.close();
    console.log('Server and database closed. Bye!');
    process.exit(0);
  });

  // Safety fallback: if keep-alive connections hang, exit promptly
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 500).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
