import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { requestIdFor } from '../src/app.js';
import { lockUser } from '../src/lib/locks.js';
import {
  alice,
  buildTestApp,
  client,
  invite,
  registerUser,
  resetDb,
  sleep,
  warmUpPool,
} from './helpers.js';

let app: FastifyInstance;
/** Every line the app logs, as written. */
const lines: string[] = [];

interface LogLine {
  level: number;
  msg: string;
  reqId?: string;
  userId?: string;
  familyId?: string;
}

const WARN = 40;

function logs(): LogLine[] {
  return lines.map((line) => JSON.parse(line) as LogLine);
}

/** The lines one request logged, found by the id in its x-request-id header. */
function linesOf(res: { headers: Record<string, unknown> }) {
  return logs().filter((line) => line.reqId === res.headers['x-request-id']);
}

/**
 * Waits until `count` queries are waiting for a lock: at most about 3
 * seconds, so that its own error shows before Vitest's 5-second test timeout.
 */
async function waitForLockWaiters(count: number) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const [row] = await app.prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((row?.waiting ?? 0) >= count) return;
    await sleep(50);
  }
  throw new Error(`${String(count)} queries never started waiting for the lock`);
}

beforeAll(async () => {
  // The most verbose level: whatever is logged at all, these tests see.
  const logStream = { write: (line: string) => lines.push(line) };
  app = await buildTestApp({ LOG_LEVEL: 'trace' }, { logStream });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb(app);
  lines.length = 0;
});

describe('logs', () => {
  it('never contain a password or a token', async () => {
    const { accessToken, refreshToken } = await registerUser(app);
    const api = client(app, accessToken);
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: alice });
    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });
    const workspace = await api.post('/workspaces', { name: 'Acme' });
    const { token } = await invite(api, workspace.json<{ id: string }>().id, 'bob@example.com');
    // Refused requests, too: a wrong password, and a token that doesn't verify.
    await app.inject({ method: 'POST', url: '/auth/login', payload: { ...alice, password: 'x' } });
    await client(app, `${accessToken}x`).get('/users/me');

    const secrets = [
      alice.password,
      accessToken,
      refreshToken,
      login.json<{ accessToken: string }>().accessToken,
      refreshed.json<{ refreshToken: string }>().refreshToken,
      token,
    ];
    const everything = lines.join('');
    expect(lines.length).toBeGreaterThan(10);
    for (const secret of secrets) expect(everything).not.toContain(secret);
  });

  it('say which user sent a request, once the token checks out', async () => {
    const { accessToken, user } = await registerUser(app);
    const mine = await client(app, accessToken).get('/users/me');
    const anonymous = await app.inject({ method: 'GET', url: '/health/live' });
    // A token that doesn't verify names no one: whoever sent it chose what it says.
    const forged = await client(app, `${accessToken}x`).get('/users/me');

    const completed = (res: typeof mine) =>
      linesOf(res).find((line) => line.msg === 'request completed');
    expect(completed(mine)).toMatchObject({ userId: user.id });
    // Each request has its own logger: the user id doesn't stick to later requests.
    expect(completed(anonymous)).not.toHaveProperty('userId');
    expect(forged.statusCode).toBe(401);
    expect(completed(forged)).toBeDefined();
    expect(completed(forged)).not.toHaveProperty('userId');
  });

  it('warn when a refresh token is used twice, naming the session but not the token', async () => {
    const { refreshToken, user } = await registerUser(app);
    const refresh = () =>
      app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    await refresh();
    const replay = await refresh();

    const warnings = logs().filter((line) => line.level === WARN);
    expect(warnings).toEqual([
      expect.objectContaining({
        msg: 'refresh token reused: session revoked',
        reqId: replay.headers['x-request-id'],
        userId: user.id,
        familyId: expect.any(String),
      }),
    ]);
    expect(lines.join('')).not.toContain(refreshToken);
  });

  it('warn too when two requests use one refresh token at the same moment', async () => {
    const { refreshToken, user } = await registerUser(app);
    const refresh = () =>
      app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    await warmUpPool(app);
    // Hold the user's lock: both refreshes find the token still unused, then
    // queue for the lock. The second to get it finds the token just used:
    // the race path of AuthService.refresh, every time.
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const held = app.prisma.$transaction(
      async (tx) => {
        await lockUser(tx, user.id);
        locked();
        await released;
      },
      { timeout: 10_000 },
    );
    // Only once the lock is ours: a refresh sent sooner could take it first.
    await lockTaken;
    const results = Promise.all([refresh(), refresh()]);
    try {
      await waitForLockWaiters(2);
    } finally {
      // Even if the test fails: a lock left held would block the next tests.
      release();
      await held;
    }

    const statuses = (await results).map((res) => res.statusCode);
    expect(statuses.toSorted((a, b) => a - b)).toEqual([200, 401]);
    const warnings = logs().filter((line) => line.level === WARN);
    expect(warnings).toEqual([
      expect.objectContaining({ msg: 'refresh token reused: session revoked', userId: user.id }),
    ]);
  });

  it('use the request id from upstream when it looks like one', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'lb-7f3a.42:1' },
    });
    expect(res.headers['x-request-id']).toBe('lb-7f3a.42:1');
    expect(linesOf(res).length).toBeGreaterThan(0);
  });
});

describe('requestIdFor()', () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('keeps an id from upstream made of letters, digits and - _ . :', () => {
    for (const id of ['f81d4fae-7dec-11d0-a765-00a0c91e6bf6', 'Lb_7f3a.42:1-x']) {
      expect(requestIdFor({ headers: { 'x-request-id': id } })).toBe(id);
    }
  });

  it('makes a fresh id when there is none, or it looks like anything else', () => {
    const odd = ['', 'has spaces', 'x'.repeat(129), '<script>', 'line\nbreak', 'ünïcode'];
    expect(requestIdFor({ headers: {} })).toMatch(uuid);
    for (const header of odd) {
      expect(requestIdFor({ headers: { 'x-request-id': header } })).toMatch(uuid);
    }
  });
});
