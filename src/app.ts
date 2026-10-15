import express from 'express';
import { WebhookStore } from './db.js';
import { WebhookDispatcher, DispatcherOptions } from './dispatcher.js';
import { createApiRouter } from './api.js';

export interface AppOptions {
  dbPath?: string;
  dispatcherOptions?: Partial<DispatcherOptions>;
}

export function createApp(
  dbPathOrOptions?: string | AppOptions,
  dispatcherOptions?: Partial<DispatcherOptions>
) {
  let dbPath = 'webhooks.db';
  let dispOptions: Partial<DispatcherOptions> | undefined = dispatcherOptions;

  if (typeof dbPathOrOptions === 'string') {
    dbPath = dbPathOrOptions;
  } else if (dbPathOrOptions && typeof dbPathOrOptions === 'object') {
    dbPath = dbPathOrOptions.dbPath ?? 'webhooks.db';
    dispOptions = dbPathOrOptions.dispatcherOptions ?? dispOptions;
  }

  const app = express();
  app.use(express.json());

  const store = new WebhookStore(dbPath);
  const dispatcher = new WebhookDispatcher({
    store,
    ...dispOptions,
  });

  app.use('/api', createApiRouter(store, dispatcher));

  // Root endpoint
  app.get('/', (_req, res) => {
    res.json({
      service: 'Reliable Webhook Delivery Service',
      version: '1.0.0',
      endpoints: {
        health: 'GET /api/health',
        registerSubscription: 'POST /api/subscriptions',
        listSubscriptions: 'GET /api/subscriptions',
        ingestEvent: 'POST /api/events',
        listEvents: 'GET /api/events',
        getEventStatus: 'GET /api/events/:id',
        manualRetry: 'POST /api/events/:id/retry',
      },
    });
  });

  return { app, store, dispatcher };
}
