import express, { Request, Response } from 'express';
import { WebhookStore } from './db.js';
import { WebhookDispatcher } from './dispatcher.js';
import { generateSecret } from './crypto.js';
import { EventStatus } from './types.js';

export function createApiRouter(store: WebhookStore, dispatcher: WebhookDispatcher) {
  const router = express.Router();

  // --- Subscriptions ---

  /**
   * Register or update a customer endpoint
   * POST /subscriptions
   */
  router.post('/subscriptions', (req: Request, res: Response) => {
    const { customerId, endpointUrl, secret } = req.body;

    if (!customerId || typeof customerId !== 'string') {
      res.status(400).json({ error: 'Missing or invalid customerId' });
      return;
    }
    if (!endpointUrl || typeof endpointUrl !== 'string') {
      res.status(400).json({ error: 'Missing or invalid endpointUrl' });
      return;
    }

    try {
      new URL(endpointUrl);
    } catch {
      res.status(400).json({ error: 'Invalid endpointUrl format. Must be a valid URL' });
      return;
    }

    const subSecret = secret && typeof secret === 'string' ? secret : generateSecret();
    const subscription = store.upsertSubscription(customerId, endpointUrl, subSecret);

    res.status(201).json({
      message: 'Subscription registered successfully',
      subscription,
    });
  });

  /**
   * List all subscriptions
   * GET /subscriptions
   */
  router.get('/subscriptions', (_req: Request, res: Response) => {
    const subscriptions = store.listSubscriptions();
    res.json({ subscriptions });
  });

  /**
   * Get subscription by customer ID
   * GET /subscriptions/:customerId
   */
  router.get('/subscriptions/:customerId', (req: Request, res: Response) => {
    const subscription = store.getSubscriptionByCustomerId(req.params.customerId);
    if (!subscription) {
      res.status(404).json({ error: 'Subscription not found for customer' });
      return;
    }
    res.json({ subscription });
  });

  // --- Events ---

  /**
   * Ingest an event from internal producers
   * POST /events
   */
  router.post('/events', (req: Request, res: Response) => {
    const { customerId, eventType, payload, maxAttempts } = req.body;

    if (!customerId || typeof customerId !== 'string') {
      res.status(400).json({ error: 'Missing or invalid customerId' });
      return;
    }

    if (!payload || typeof payload !== 'object') {
      res.status(400).json({ error: 'Missing or invalid payload (must be JSON object)' });
      return;
    }

    const subscription = store.getSubscriptionByCustomerId(customerId);
    if (!subscription) {
      res.status(404).json({
        error: `Customer '${customerId}' does not have a registered webhook endpoint. Please register via POST /subscriptions first.`,
      });
      return;
    }

    const type = eventType && typeof eventType === 'string' ? eventType : 'default';
    const attempts = typeof maxAttempts === 'number' && maxAttempts > 0 ? maxAttempts : 5;

    const event = store.createEvent(
      customerId,
      subscription.id,
      type,
      payload,
      attempts
    );

    // Trigger immediate poll so delivery starts without delay
    setImmediate(() => dispatcher.pollAndDispatch());

    res.status(202).json({
      message: 'Event accepted for delivery',
      event,
    });
  });

  /**
   * List events with optional filters (customerId, status, pagination)
   * GET /events?customerId=...&status=...&limit=...&offset=...
   */
  router.get('/events', (req: Request, res: Response) => {
    const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : undefined;
    const status = typeof req.query.status === 'string' ? (req.query.status as EventStatus) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

    const result = store.listEvents({
      customerId,
      status,
      limit,
      offset,
    });

    res.json(result);
  });

  /**
   * Get event delivery status and full attempt history
   * GET /events/:id
   */
  router.get('/events/:id', (req: Request, res: Response) => {
    const event = store.getEventById(req.params.id);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    res.json({ event });
  });

  /**
   * Manually replay / retry a failed event (Dead-Letter queue recovery)
   * POST /events/:id/retry
   */
  router.post('/events/:id/retry', (req: Request, res: Response) => {
    const event = store.getEventById(req.params.id);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const updated = store.retryEvent(req.params.id);
    setImmediate(() => dispatcher.pollAndDispatch());

    res.json({
      message: 'Event requeued for delivery',
      event: updated,
    });
  });

  /**
   * Health and metrics endpoint
   * GET /health
   */
  router.get('/health', (_req: Request, res: Response) => {
    const stats = store.getStats();
    const metrics = dispatcher.getMetrics();

    res.json({
      status: 'ok',
      uptimeSeconds: process.uptime(),
      stats,
      dispatcher: metrics,
    });
  });

  return router;
}
