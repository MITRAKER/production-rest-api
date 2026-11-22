import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loggerOptions } from '../src/app.js';
import { buildTestApp } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
  // A route that fails the way a real bug would, only in this test app.
  app.get('/test/boom', () => {
    throw new Error('connection string postgres://secret@db/prod');
  });
});
afterAll(async () => {
  await app.close();
});

describe('error responses', () => {
  it('hides unexpected errors behind a generic 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });
    expect(res.body).not.toContain('secret');
  });

  it('reports malformed JSON as a 400 with Fastify’s error code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('FST_ERR_CTP_INVALID_JSON_BODY');
  });

  it('rejects unsupported content types with 415', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'content-type': 'application/xml' },
      payload: '<login/>',
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('FST_ERR_CTP_INVALID_MEDIA_TYPE');
  });

  it('rejects bodies over the size limit with 413 (Power of Ten rule 3)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'a@example.com', password: 'x'.repeat(100_000) },
    });
    expect(res.statusCode).toBe(413);
  });

  it('uses the same shape for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('loggerOptions()', () => {
  it('pretty-prints in development and redacts credentials everywhere', () => {
    const dev = loggerOptions({ NODE_ENV: 'development', LOG_LEVEL: 'info' });
    const prod = loggerOptions({ NODE_ENV: 'production', LOG_LEVEL: 'info' });
    expect(dev).toHaveProperty('transport');
    expect(prod).not.toHaveProperty('transport');
    expect(dev.redact).toContain('req.headers.authorization');
    expect(prod.redact).toContain('req.headers.authorization');
  });
});
