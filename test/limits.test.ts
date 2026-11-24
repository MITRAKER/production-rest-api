import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  createProject,
  createTask,
  invite,
  resetDb,
  signUp,
  warmUpPool,
} from './helpers.js';

/**
 * Power of Ten rule 3: what can exist at once (workspaces per user; members,
 * pending invitations and projects per workspace; tasks per project) is
 * bounded. The quotas are environment variables, so the tests can use tiny
 * ones.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp({
    MAX_WORKSPACES_PER_USER: '2',
    MAX_MEMBERS_PER_WORKSPACE: '2',
    MAX_PENDING_INVITATIONS: '2',
    MAX_PROJECTS_PER_WORKSPACE: '2',
    MAX_TASKS_PER_PROJECT: '2',
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

  it('holds when several invitations arrive at the same instant', async () => {
    const alice = await signUp(app, 'Alice');
    const workspaceId = await createWorkspace(alice.api, 'Acme');
    const url = `/workspaces/${workspaceId}/invitations`;

    // Without the lock, this race is lost only most of the time (inviting
    // runs several queries before it counts), so the test runs it three times.
    for (const round of [1, 2, 3]) {
      // Revoke everything, then take one of the two slots.
      await app.prisma.invitation.updateMany({
        where: { workspaceId },
        data: { revokedAt: new Date() },
      });
      await invite(alice.api, workspaceId, `bob${String(round)}@example.com`);

      await warmUpPool(app);
      // One slot left, five requests (to five different people) racing for it.
      const emails = ['carol', 'dave', 'erin', 'frank', 'grace'].map(
        (name) => `${name}${String(round)}@example.com`,
      );
      const results = await Promise.all(emails.map((email) => alice.api.post(url, { email })));
      const codes = results.map((r) => r.statusCode).sort((a, b) => a - b);
      expect(codes).toEqual([201, 409, 409, 409, 409]);
    }
    expect(await app.prisma.invitation.count({ where: { workspaceId } })).toBe(6);
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

describe('projects per workspace', () => {
  it('refuses to create more projects than the quota, until one is deleted', async () => {
    const alice = await signUp(app, 'Alice');
    const workspaceId = await createWorkspace(alice.api, 'Acme');
    const first = await createProject(alice.api, workspaceId, 'One');
    await createProject(alice.api, workspaceId, 'Two');

    const url = `/workspaces/${workspaceId}/projects`;
    const res = await alice.api.post(url, { name: 'Three' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LIMIT_REACHED');

    await alice.api.delete(`${url}/${first.id}`);
    expect((await alice.api.post(url, { name: 'Three' })).statusCode).toBe(201);
  });

  it('holds when several creations arrive at the same instant', async () => {
    const alice = await signUp(app, 'Alice');
    const workspaceId = await createWorkspace(alice.api, 'Acme');
    const url = `/workspaces/${workspaceId}/projects`;

    for (const round of [1, 2, 3]) {
      await app.prisma.project.deleteMany({ where: { workspaceId } });
      await createProject(alice.api, workspaceId, `First ${String(round)}`);

      await warmUpPool(app);
      // One slot left, five requests racing for it.
      const names = ['A', 'B', 'C', 'D', 'E'];
      const results = await Promise.all(names.map((name) => alice.api.post(url, { name })));
      const codes = results.map((r) => r.statusCode).sort((a, b) => a - b);
      expect(codes).toEqual([201, 409, 409, 409, 409]);
      expect(await app.prisma.project.count({ where: { workspaceId } })).toBe(2);
    }
  });
});

describe('tasks per project', () => {
  async function aliceWithProject() {
    const alice = await signUp(app, 'Alice');
    const workspaceId = await createWorkspace(alice.api, 'Acme');
    const project = await createProject(alice.api, workspaceId);
    const tasksUrl = `/workspaces/${workspaceId}/projects/${project.id}/tasks`;
    return { alice, projectId: project.id, tasksUrl };
  }

  it('refuses to create more tasks than the quota, until one is deleted', async () => {
    const { alice, tasksUrl } = await aliceWithProject();
    const first = await createTask(alice.api, tasksUrl);
    await createTask(alice.api, tasksUrl);

    const res = await alice.api.post(tasksUrl, { title: 'One too many' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LIMIT_REACHED');

    await alice.api.delete(`${tasksUrl}/${first.id}`);
    expect((await alice.api.post(tasksUrl, { title: 'Room again' })).statusCode).toBe(201);
  });

  it('holds when several creations arrive at the same instant', async () => {
    const { alice, projectId, tasksUrl } = await aliceWithProject();

    for (const round of [1, 2, 3]) {
      await app.prisma.task.deleteMany({ where: { projectId } });
      await createTask(alice.api, tasksUrl, { title: `First ${String(round)}` });

      await warmUpPool(app);
      // One slot left, five requests racing for it.
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map(() => alice.api.post(tasksUrl, { title: 'Racing' })),
      );
      const codes = results.map((r) => r.statusCode).sort((a, b) => a - b);
      expect(codes).toEqual([201, 409, 409, 409, 409]);
      expect(await app.prisma.task.count({ where: { projectId } })).toBe(2);
    }
  });
});
