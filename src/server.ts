import express, { type Request, type Response } from 'express';
import path from 'path';
import { parseAllSessions } from './parser.js';
import type { DashboardData } from './types.js';

function createServer(): express.Express {
  const app = express();

  // Cache parsed data (reparse on demand via refresh endpoint)
  let cachedData: DashboardData | null = null;

  app.get('/api/data', async (_req: Request, res: Response) => {
    try {
      if (!cachedData) {
        cachedData = await parseAllSessions();
      }
      res.json(cachedData);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/refresh', async (_req: Request, res: Response) => {
    try {
      cachedData = await parseAllSessions();
      res.json({ ok: true, sessions: cachedData.sessions.length });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Serve static dashboard
  app.use(express.static(path.join(__dirname, 'public')));

  return app;
}

export { createServer };
