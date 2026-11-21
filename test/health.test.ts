import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

describe('health endpoints', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp(loadEnv());
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready reports the database is up', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', database: 'up' });
  });

  it('GET /health/ready answers 503 when the database is unreachable', async () => {
    const spy = vi
      .spyOn(app.prisma, '$queryRaw')
      .mockRejectedValueOnce(new Error('connection refused'));
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    spy.mockRestore();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', database: 'down' });
  });

  it('returns a request id header for tracing', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('unknown routes return 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
  });
});

describe('environment validation', () => {
  it('rejects a missing DATABASE_URL with a clear message', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-Postgres DATABASE_URL', () => {
    expect(() => loadEnv({ DATABASE_URL: 'mysql://x@y/z' })).toThrow(/DATABASE_URL/);
  });

  it('bounds the tasks per workspace: projects per workspace × tasks per project', () => {
    const base = {
      DATABASE_URL: 'postgresql://api:api@localhost:5432/api',
      JWT_ACCESS_SECRET: 'x'.repeat(32),
    };
    expect(loadEnv(base)).toMatchObject({
      MAX_PROJECTS_PER_WORKSPACE: 20,
      MAX_TASKS_PER_PROJECT: 5_000,
    });
    const both = { MAX_PROJECTS_PER_WORKSPACE: '100', MAX_TASKS_PER_PROJECT: '1000' };
    expect(loadEnv({ ...base, ...both })).toMatchObject({ MAX_TASKS_PER_PROJECT: 1_000 });
    const tooMany = { MAX_PROJECTS_PER_WORKSPACE: '100', MAX_TASKS_PER_PROJECT: '5000' };
    expect(() => loadEnv({ ...base, ...tooMany })).toThrow(/MAX_TASKS_PER_PROJECT: .*100,000/);
  });
});
