import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { alice, buildTestApp, registerUser, resetDb } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb(app);
});

describe('POST /auth/register', () => {
  it('creates a user and returns tokens, without the password hash', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: alice });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({ email: alice.email, name: 'Alice' });
    expect(body.user.passwordHash).toBeUndefined();
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));
    expect(body.tokenType).toBe('Bearer');
  });

  it('stores a hash, never the plain password', async () => {
    await registerUser(app);
    const row = await app.prisma.user.findUniqueOrThrow({ where: { email: alice.email } });
    expect(row.passwordHash).not.toContain(alice.password);
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('normalizes email case and whitespace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { ...alice, email: '  Alice@Example.COM ' },
    });
    expect(res.json().user.email).toBe('alice@example.com');
  });

  it('rejects a duplicate email with 409', async () => {
    await registerUser(app);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { ...alice, email: 'ALICE@example.com' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('rejects invalid input with 400 and field details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'not-an-email', password: 'short', name: '' },
    });
    expect(res.statusCode).toBe(400);
    const { error } = res.json();
    expect(error.code).toBe('VALIDATION_ERROR');
    const paths = error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['/email', '/password', '/name']));
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await registerUser(app);
  });

  it('logs in with correct credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: alice.email, password: alice.password },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toEqual(expect.any(String));
  });

  it('gives the same error for a wrong password and an unknown email', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: alice.email, password: 'wrong password' },
    });
    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.com', password: alice.password },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
  });
});

describe('GET /users/me', () => {
  it('returns the current user with a valid access token', async () => {
    const { accessToken } = await registerUser(app);
    const res = await app.inject({
      method: 'GET',
      url: '/users/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(alice.email);
  });

  it('rejects a valid token whose account no longer exists', async () => {
    const { accessToken, user } = await registerUser(app);
    await app.prisma.user.delete({ where: { id: user.id } });
    const res = await app.inject({
      method: 'GET',
      url: '/users/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing token', async () => {
    const res = await app.inject({ method: 'GET', url: '/users/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a tampered token', async () => {
    const { accessToken } = await registerUser(app);
    const [header, , signature] = accessToken.split('.');
    if (header === undefined || signature === undefined) throw new Error('malformed JWT');
    const fakePayload = Buffer.from(JSON.stringify({ sub: 'someone-else' })).toString('base64url');
    const res = await app.inject({
      method: 'GET',
      url: '/users/me',
      headers: { authorization: `Bearer ${header}.${fakePayload}.${signature}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired token', async () => {
    const shortLived = await buildTestApp({ JWT_ACCESS_TTL: '1ms' });
    try {
      const { accessToken } = await registerUser(shortLived);
      await new Promise((r) => setTimeout(r, 1100));
      const res = await shortLived.inject({
        method: 'GET',
        url: '/users/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await shortLived.close();
    }
  });
});

describe('POST /auth/refresh', () => {
  it('rotates: returns a new refresh token and the old one stops working', async () => {
    const { refreshToken } = await registerUser(app);

    const first = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const rotated = first.json().refreshToken;
    expect(rotated).not.toBe(refreshToken);

    const again = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });
    expect(again.statusCode).toBe(401);
  });

  it('detects reuse of an old token and revokes the whole session', async () => {
    const { refreshToken: original } = await registerUser(app);
    const rotated = (
      await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: original },
      })
    ).json().refreshToken;

    // An attacker replays the stolen original token...
    await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: original } });

    // ...so even the legitimate, newer token is now revoked.
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: rotated },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('lets only one of two simultaneous refreshes win, then ends the session', async () => {
    const { refreshToken } = await registerUser(app);
    const results = await Promise.all([
      app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } }),
      app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } }),
    ]);
    expect(results.map((r) => r.statusCode).sort((a, b) => a - b)).toEqual([200, 401]);

    // The loser looks exactly like a stolen-token replay, so the session is revoked:
    // even the winner's new refresh token no longer works.
    const winner = results.find((r) => r.statusCode === 200);
    const next = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: winner?.json().refreshToken },
    });
    expect(next.statusCode).toBe(401);
    const live = await app.prisma.refreshToken.count({ where: { revokedAt: null } });
    expect(live).toBe(0);
  });

  it('rejects an unknown token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: 'made-up' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired refresh token', async () => {
    const { refreshToken } = await registerUser(app);
    await app.prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the refresh token', async () => {
    const { refreshToken } = await registerUser(app);
    const out = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken },
    });
    expect(out.statusCode).toBe(204);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(401);
  });

  it('is idempotent for unknown tokens', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken: 'whatever' },
    });
    expect(res.statusCode).toBe(204);
  });
});

describe('rate limiting', () => {
  it('blocks too many login attempts with 429', async () => {
    const limited = await buildTestApp({ AUTH_RATE_LIMIT_MAX: '3' });
    try {
      const attempt = () =>
        limited.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: 'x@example.com', password: 'nope' },
        });
      for (let i = 0; i < 3; i++) expect((await attempt()).statusCode).toBe(401);
      const blocked = await attempt();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });
});
