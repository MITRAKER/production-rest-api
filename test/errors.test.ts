import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loggerOptions } from '../src/app.js';
import { ERROR_CODES } from '../src/lib/errors.js';
import { buildTestApp } from './helpers.js';

let app: FastifyInstance;
const logs: string[] = [];

beforeAll(async () => {
  app = await buildTestApp(
    { LOG_LEVEL: 'error' },
    { logStream: { write: (line) => logs.push(line) } },
  );
  // Routes that fail the way real bugs would, only in this test app.
  app.get('/test/boom', () => {
    throw new Error('connection string postgres://secret@db/prod');
  });
  app.get(
    '/test/wrong-answer',
    { schema: { response: { 200: z.object({ done: z.boolean() }) } } },
    () => ({ done: 'yes' }),
  );
});
afterAll(async () => {
  await app.close();
});

/** Sends a body that isn't what /auth/login expects, in the way given. */
async function postLogin(headers: Record<string, string>, payload: string) {
  return app.inject({ method: 'POST', url: '/auth/login', headers, payload });
}

describe('error responses', () => {
  it('hides unexpected errors behind a generic 500, and logs them in full', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });
    expect(res.body).not.toContain('secret');
    expect(logs.join('')).toContain('postgres://secret@db/prod');
  });

  it('answers 500 when a handler answers what its schema forbids', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/wrong-answer' });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
    expect(logs.join('')).toContain('response does not match its schema');
  });

  it('reports malformed JSON as INVALID_JSON, never with Fastify’s own codes', async () => {
    const json = { 'content-type': 'application/json' };
    for (const res of [await postLogin(json, '{"email": '), await postLogin(json, '')]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_JSON');
    }
  });

  it('rejects unsupported content types with 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const res = await postLogin({ 'content-type': 'application/xml' }, '<login/>');
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects bodies over the size limit with 413 (Power of Ten rule 3)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'a@example.com', password: 'x'.repeat(100_000) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers errors from before routing in the same shape, with a request id', async () => {
    const badUrl = await app.inject({ method: 'GET', url: '/workspaces/%E0%A4%A' });
    const longParam = await app.inject({ method: 'GET', url: `/workspaces/${'x'.repeat(101)}` });
    expect([badUrl.statusCode, longParam.statusCode]).toEqual([400, 414]);
    for (const res of [badUrl, longParam]) {
      expect(res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: expect.any(String) } });
      expect(res.headers['x-request-id']).toEqual(expect.any(String));
    }
  });

  it('uses the same shape for unknown routes, without echoing the query string', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope?token=secret' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route GET /nope not found' },
    });
  });

  it('keeps every error code unique and in SCREAMING_SNAKE_CASE', () => {
    // Clients switch on these codes: Fastify checks every error answer against
    // the catalog, so these are the only codes that can ever be sent.
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) expect(code).toMatch(/^[A-Z]+(_[A-Z]+)*$/);
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
