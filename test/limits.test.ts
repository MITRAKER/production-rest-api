import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, invite, resetDb, signUp, warmUpPool } from './helpers.js';

/**
 * Power of Ten rule 3: nothing a user creates grows without limit.
 * The quotas are environment variables, so the tests can use tiny ones.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp({
    MAX_WORKSPACES_PER_USER: '2',
    MAX_MEMBERS_PER_WORKSPACE: '2',
    MAX_PENDING_INVITATIONS: '2',
  });
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb(app);
});

async function createWorkspace(api: Awaited<ReturnType<typeof signUp>>['api'], name: string) {
  const res = await api.post('/workspaces', { name });
  if (res.statusCode !== 201) throw new Error(`create failed: ${res.body}`);
  return res.json<{ id: string }>().id;
}

describe('workspaces per user', () => {
  it('refuses to create more workspaces than the quota', async () => {
    const alice = await signUp(app, 'Alice');
    await createWorkspace(alice.api, 'One');
    await createWorkspace(alice.api, 'Two');

    const res = await alice.api.post('/workspaces', { name: 'Three' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LIMIT_REACHED');
    expect((await alice.api.get('/workspaces')).json().data).toHaveLength(2);
  });

  it('holds when several creations arrive at the same instant', async () => {
    const alice = await signUp(app, 'Alice');
    await createWorkspace(alice.api, 'One');

    await warmUpPool(app);
    // One slot left, five requests racing for it.
    const names = ['Two', 'Three', 'Four', 'Five', 'Six'];
    const results = await Promise.all(names.map((name) => alice.api.post('/workspaces', { name })));
    const codes = results.map((r) => r.statusCode).sort((a, b) => a - b);
    expect(codes).toEqual([201, 409, 409, 409, 409]);
    expect(await app.prisma.membership.count({ where: { userId: alice.id } })).toBe(2);
  });

  it('also counts workspaces joined by invitation', async () => {
    const alice = await signUp(app, 'Alice');
    const bob = await signUp(app, 'Bob');
    const workspaceId = await createWorkspace(alice.api, 'Acme');
    await createWorkspace(bob.api, 'Bob One');
    await createWorkspace(bob.api, 'Bob Two');

    const { token } = await invite(alice.api, workspaceId, bob.email);
    const res = await bob.api.post('/invitations/accept', { token });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LIMIT_REACHED');
  });
});

describe('pending invitations per workspace', () => {
  it('refuses new invitations once the quota is reached, until one is revoked', async () => {
    const alice = await signUp(app, 'Alice');
    const workspaceId = await createWorkspace(alice.api, 'Acme');
    const { invitation } = await invite(alice.api, workspaceId, 'bob@example.com');
    await invite(alice.api, workspaceId, 'carol@example.com');

    const url = `/workspaces/${workspaceId}/invitations`;
    const refused = await alice.api.post(url, { email: 'dave@example.com' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('LIMIT_REACHED');

    await alice.api.delete(`${url}/${invitation.id}`);
    expect((await alice.api.post(url, { email: 'dave@example.com' })).statusCode).toBe(201);
  });
});

describe('members per workspace', () => {
  it("refuses to accept into a full workspace, and the invitation isn't used up", async () => {
    const alice = await signUp(app, 'Alice');
    const bob = await signUp(app, 'Bob');
    const carol = await signUp(app, 'Carol');
    const workspaceId = await createWorkspace(alice.api, 'Acme');
    const forBob = await invite(alice.api, workspaceId, bob.email);
    const forCarol = await invite(alice.api, workspaceId, carol.email);

    expect((await bob.api.post('/invitations/accept', { token: forBob.token })).statusCode).toBe(
      200,
    );
    const full = await carol.api.post('/invitations/accept', { token: forCarol.token });
    expect(full.statusCode).toBe(409);
    expect(full.json().error.code).toBe('LIMIT_REACHED');

    // The failed accept was rolled back: once Bob leaves, Carol's invitation still works.
    await bob.api.delete(`/workspaces/${workspaceId}/members/${bob.id}`);
    const later = await carol.api.post('/invitations/accept', { token: forCarol.token });
    expect(later.statusCode).toBe(200);
  });

  it('lets only one of two simultaneous accepts take the last seat', async () => {
    const alice = await signUp(app, 'Alice');
    const bob = await signUp(app, 'Bob');
    const carol = await signUp(app, 'Carol');
    const workspaceId = await createWorkspace(alice.api, 'Acme');
    const forBob = await invite(alice.api, workspaceId, bob.email);
    const forCarol = await invite(alice.api, workspaceId, carol.email);

    await warmUpPool(app);
    const results = await Promise.all([
      bob.api.post('/invitations/accept', { token: forBob.token }),
      carol.api.post('/invitations/accept', { token: forCarol.token }),
    ]);
    expect(results.map((r) => r.statusCode).sort((a, b) => a - b)).toEqual([200, 409]);
    expect(await app.prisma.membership.count({ where: { workspaceId } })).toBe(2);
  });
});
