import express, { Request, Response } from 'express';

const app = express();
app.use(express.json());

interface ReceivedWebhook {
  id: string;
  path: string;
  timestamp: string;
  headers: Record<string, any>;
  body: any;
}

const receivedWebhooks: ReceivedWebhook[] = [];
let flakyAttemptCount = 0;

// Log every incoming request
app.use((req, _res, next) => {
  console.log(`[MockCustomer] Received ${req.method} ${req.path}`);
  next();
});

// 1. Success endpoint: Always returns 200 OK
app.post('/webhook/success', (req: Request, res: Response) => {
  const item: ReceivedWebhook = {
    id: req.headers['x-webhook-id'] as string || 'unknown',
    path: req.path,
    timestamp: new Date().toISOString(),
    headers: req.headers,
    body: req.body,
  };
  receivedWebhooks.push(item);

  console.log(`[MockCustomer] ✅ /webhook/success received event ID: ${item.id}`);
  res.status(200).json({ received: true, eventId: item.id });
});

// 2. Flaky endpoint: Fails first 2 times with 503, succeeds on 3rd attempt
app.post('/webhook/flaky', (req: Request, res: Response) => {
  flakyAttemptCount++;
  const eventId = req.headers['x-webhook-id'] as string;
  const attempt = req.headers['x-webhook-attempt'] as string;

  console.log(`[MockCustomer] 🔄 /webhook/flaky attempt #${flakyAttemptCount} (Header attempt: ${attempt})`);

  if (flakyAttemptCount < 3) {
    res.status(503).json({
      error: 'Service Temporarily Unavailable (Simulated failure)',
      flakyAttemptCount,
    });
  } else {
    receivedWebhooks.push({
      id: eventId,
      path: req.path,
      timestamp: new Date().toISOString(),
      headers: req.headers,
      body: req.body,
    });
    console.log(`[MockCustomer] ✅ /webhook/flaky recovered! Event ID: ${eventId}`);
    res.status(200).json({
      received: true,
      recoveredAtAttempt: flakyAttemptCount,
      eventId,
    });
  }
});

// 3. Always failing endpoint: Always returns 500
app.post('/webhook/failing', (req: Request, res: Response) => {
  const eventId = req.headers['x-webhook-id'] as string;
  const attempt = req.headers['x-webhook-attempt'] as string;

  console.log(`[MockCustomer] ❌ /webhook/failing rejected event ${eventId} (attempt ${attempt})`);
  res.status(500).json({ error: 'Endpoint Internal Server Error (Always fails)' });
});

// 4. Fatal endpoint: Always returns 404 and is not retryable in a real customer setup
app.post('/webhook/fatal-404', (req: Request, res: Response) => {
  const eventId = req.headers['x-webhook-id'] as string;
  console.log(`[MockCustomer] ❌ /webhook/fatal-404 rejected event ${eventId} with 404`);
  res.status(404).json({ error: 'Endpoint Not Found (Simulated fatal failure)' });
});

// 4. Slow endpoint: Takes 6000ms to respond (triggers client timeout)
app.post('/webhook/slow', async (req: Request, res: Response) => {
  console.log('[MockCustomer] ⏳ /webhook/slow hanging for 6s...');
  await new Promise((r) => setTimeout(r, 6000));
  res.status(200).json({ received: true, delayed: true });
});

// Inspection & Reset endpoints
app.get('/webhook/received', (_req: Request, res: Response) => {
  res.json({ count: receivedWebhooks.length, received: receivedWebhooks });
});

app.post('/webhook/reset', (_req: Request, res: Response) => {
  flakyAttemptCount = 0;
  receivedWebhooks.length = 0;
  console.log('[MockCustomer] State reset.');
  res.json({ message: 'State reset successfully' });
});

export function startMockCustomerServer(port = process.env.MOCK_PORT ? parseInt(process.env.MOCK_PORT, 10) : 4000) {
  const server = app.listen(port, () => {
    console.log(`
=============================================================
🤖 Mock Customer Receiver is running on http://localhost:${port}
=============================================================
Available mock endpoints:
  POST /webhook/success  - Always returns 200 OK
  POST /webhook/flaky    - Fails 2x with 503, then returns 200 on 3rd attempt
  POST /webhook/failing  - Always returns 500 Internal Error
  POST /webhook/fatal-404 - Always returns 404 Not Found
  POST /webhook/slow     - Hangs for 6s (tests timeout)
  GET  /webhook/received - Inspect received webhooks
  POST /webhook/reset    - Reset flaky counter and logs
=============================================================
`);
  });

  return server;
}

if (require.main === module) {
  const server = startMockCustomerServer();
  const shutdownMock = () => {
    console.log('\nShutting down mock receiver...');
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };

  process.on('SIGINT', shutdownMock);
  process.on('SIGTERM', shutdownMock);
}
