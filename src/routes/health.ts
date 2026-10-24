import { Hono } from 'hono';

import type { HealthResponse } from '../contract.js';

export function createHealthRoute(): Hono {
  return new Hono().get('/health', (c) => c.json<HealthResponse>({ ok: true }));
}
