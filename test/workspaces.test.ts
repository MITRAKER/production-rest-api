import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, client, createTeam, resetDb, signUp } from './helpers.js';

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

describe('POST /workspaces', () => {
  it('creates a workspace and makes the creator its OWNER', async () => {
    const alice = await signUp(app, 'Alice');
    const res = await alice.api.post('/workspaces', { name: '  Acme  ' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: 'Acme', role: 'OWNER' });

    const membership = await app.prisma.membership.findFirstOrThrow({
      where: { workspaceId: res.json().id },
    });
    expect(membership).toMatchObject({ userId: alice.id, role: 'OWNER' });
  });

  it('requires authentication', async () => {
    const res = await client(app).post('/workspaces', { name: 'Acme' });
    expect(res.statusCode).toBe(401);
  });

  it('validates the name', async () => {
    const alice = await signUp(app, 'Alice');
    expect((await alice.api.post('/workspaces', { name: '   ' })).statusCode).toBe(400);
    expect((await alice.api.post('/workspaces', { name: 'x'.repeat(101) })).statusCode).toBe(400);
  });
});

describe('GET /workspaces', () => {
  it("lists only the caller's workspaces, each with the caller's role", async () => {
    const team = await createTeam(app);
    const own = await team.owner.api.get('/workspaces');
    expect(own.json().data).toEqual([expect.objectContaining({ name: 'Acme', role: 'OWNER' })]);

    const member = await team.member.api.get('/workspaces');
    expect(member.json().data).toEqual([expect.objectContaining({ name: 'Acme', role: 'MEMBER' })]);

    const outsider = await team.outsider.api.get('/workspaces');
    expect(outsider.json().data).toEqual([]);
  });
});

describe('GET /workspaces/:workspaceId', () => {
  it('lets members read it', async () => {
    const team = await createTeam(app);
    const res = await team.member.api.get(team.url);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: team.workspaceId, role: 'MEMBER' });
  });

  it('answers outsiders exactly as if the workspace did not exist', async () => {
    const team = await createTeam(app);
    const outsider = await team.outsider.api.get(team.url);
    const missing = await team.outsider.api.get(`/workspaces/${randomUUID()}`);
    expect(outsider.statusCode).toBe(404);
    expect(outsider.json()).toEqual(missing.json());
  });

  it('rejects a malformed id with 400, not a database error', async () => {
    const alice = await signUp(app, 'Alice');
    const res = await alice.api.get('/workspaces/not-a-uuid');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /workspaces/:workspaceId', () => {
  it('lets an admin rename it', async () => {
    const team = await createTeam(app);
    const res = await team.admin.api.patch(team.url, { name: 'Acme Inc' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Acme Inc', role: 'ADMIN' });
  });

  it('forbids members (403) and hides it from outsiders (404)', async () => {
    const team = await createTeam(app);
    const member = await team.member.api.patch(team.url, { name: 'Hacked' });
    expect(member.statusCode).toBe(403);
    expect(member.json().error.code).toBe('FORBIDDEN');
    expect((await team.outsider.api.patch(team.url, { name: 'Hacked' })).statusCode).toBe(404);
  });
});

describe('DELETE /workspaces/:workspaceId', () => {
  it('only the owner can delete it', async () => {
    const team = await createTeam(app);
    expect((await team.admin.api.delete(team.url)).statusCode).toBe(403);
    expect((await team.member.api.delete(team.url)).statusCode).toBe(403);
    expect((await team.outsider.api.delete(team.url)).statusCode).toBe(404);
    expect((await team.owner.api.delete(team.url)).statusCode).toBe(204);
  });

  it('removes its memberships and invitations too', async () => {
    const team = await createTeam(app);
    await team.owner.api.post(`${team.url}/invitations`, { email: 'erin@example.com' });
    await team.owner.api.delete(team.url);

    expect((await team.owner.api.get(team.url)).statusCode).toBe(404);
    expect(await app.prisma.membership.count()).toBe(0);
    expect(await app.prisma.invitation.count()).toBe(0);
  });
});

describe('GET /workspaces/:workspaceId/members', () => {
  it('lists members with their roles', async () => {
    const team = await createTeam(app);
    const res = await team.member.api.get(`${team.url}/members`);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      expect.objectContaining({ name: 'Alice', role: 'OWNER' }),
      expect.objectContaining({ name: 'Bob', role: 'ADMIN' }),
      expect.objectContaining({ name: 'Carol', role: 'MEMBER' }),
    ]);
  });

  it('hides members from outsiders', async () => {
    const team = await createTeam(app);
    expect((await team.outsider.api.get(`${team.url}/members`)).statusCode).toBe(404);
  });
});

describe('PATCH /workspaces/:workspaceId/members/:userId (change role)', () => {
  it('lets the owner promote a member', async () => {
    const team = await createTeam(app);
    const res = await team.owner.api.patch(`${team.url}/members/${team.member.id}`, {
      role: 'ADMIN',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ userId: team.member.id, role: 'ADMIN' });
  });

  it('forbids admins and members from changing roles', async () => {
    const team = await createTeam(app);
    const byAdmin = await team.admin.api.patch(`${team.url}/members/${team.member.id}`, {
      role: 'ADMIN',
    });
    const byMember = await team.member.api.patch(`${team.url}/members/${team.member.id}`, {
      role: 'OWNER',
    });
    expect(byAdmin.statusCode).toBe(403);
    expect(byMember.statusCode).toBe(403);
  });

  it('returns 404 for someone who is not a member, 400 for an unknown role', async () => {
    const team = await createTeam(app);
    const notMember = await team.owner.api.patch(`${team.url}/members/${team.outsider.id}`, {
      role: 'ADMIN',
    });
    expect(notMember.statusCode).toBe(404);
    const badRole = await team.owner.api.patch(`${team.url}/members/${team.member.id}`, {
      role: 'SUPERUSER',
    });
    expect(badRole.statusCode).toBe(400);
  });

  it('never lets the last owner step down', async () => {
    const team = await createTeam(app);
    const res = await team.owner.api.patch(`${team.url}/members/${team.owner.id}`, {
      role: 'ADMIN',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LAST_OWNER');
  });

  it('lets an owner step down once someone else is an owner (ownership transfer)', async () => {
    const team = await createTeam(app);
    await team.owner.api.patch(`${team.url}/members/${team.admin.id}`, { role: 'OWNER' });
    const res = await team.owner.api.patch(`${team.url}/members/${team.owner.id}`, {
      role: 'MEMBER',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('MEMBER');
  });

  it('keeps one owner even when two owners demote each other at the same instant', async () => {
    const team = await createTeam(app);
    await team.owner.api.patch(`${team.url}/members/${team.admin.id}`, { role: 'OWNER' });

    // Without the row lock, both requests could see "2 owners" and both succeed,
    // leaving the workspace with no owner at all.
    const results = await Promise.all([
      team.owner.api.patch(`${team.url}/members/${team.admin.id}`, { role: 'MEMBER' }),
      team.admin.api.patch(`${team.url}/members/${team.owner.id}`, { role: 'MEMBER' }),
    ]);

    // With the lock, they run one after the other. The second one re-reads its
    // caller's role under the lock, finds they were just demoted to MEMBER,
    // and is refused with 403.
    expect(results.map((r) => r.statusCode).sort((a, b) => a - b)).toEqual([200, 403]);
    const owners = await app.prisma.membership.count({
      where: { workspaceId: team.workspaceId, role: 'OWNER' },
    });
    expect(owners).toBe(1);
  });
});

describe('DELETE /workspaces/:workspaceId/members/:userId (remove / leave)', () => {
  it('lets an admin remove a member, who then loses access', async () => {
    const team = await createTeam(app);
    const res = await team.admin.api.delete(`${team.url}/members/${team.member.id}`);
    expect(res.statusCode).toBe(204);
    expect((await team.member.api.get(team.url)).statusCode).toBe(404);
  });

  it('only lets you remove people with a lower role than yours', async () => {
    const team = await createTeam(app);
    // A second admin, so we can check admin -> admin.
    await team.owner.api.patch(`${team.url}/members/${team.member.id}`, { role: 'ADMIN' });

    expect((await team.admin.api.delete(`${team.url}/members/${team.owner.id}`)).statusCode).toBe(
      403,
    );
    expect((await team.admin.api.delete(`${team.url}/members/${team.member.id}`)).statusCode).toBe(
      403,
    );
    expect((await team.owner.api.delete(`${team.url}/members/${team.admin.id}`)).statusCode).toBe(
      204,
    );
  });

  it('forbids members from removing others', async () => {
    const team = await createTeam(app);
    const res = await team.member.api.delete(`${team.url}/members/${team.admin.id}`);
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 when removing someone who is not a member', async () => {
    const team = await createTeam(app);
    const res = await team.admin.api.delete(`${team.url}/members/${team.outsider.id}`);
    expect(res.statusCode).toBe(404);
  });

  it('lets anyone leave, except the last owner', async () => {
    const team = await createTeam(app);
    expect((await team.member.api.delete(`${team.url}/members/${team.member.id}`)).statusCode).toBe(
      204,
    );
    const ownerLeaves = await team.owner.api.delete(`${team.url}/members/${team.owner.id}`);
    expect(ownerLeaves.statusCode).toBe(409);
    expect(ownerLeaves.json().error.code).toBe('LAST_OWNER');
  });

  it('keeps one owner even when two owners leave at the same instant', async () => {
    const team = await createTeam(app);
    await team.owner.api.patch(`${team.url}/members/${team.admin.id}`, { role: 'OWNER' });

    const results = await Promise.all([
      team.owner.api.delete(`${team.url}/members/${team.owner.id}`),
      team.admin.api.delete(`${team.url}/members/${team.admin.id}`),
    ]);

    expect(results.map((r) => r.statusCode).sort((a, b) => a - b)).toEqual([204, 409]);
    const owners = await app.prisma.membership.count({
      where: { workspaceId: team.workspaceId, role: 'OWNER' },
    });
    expect(owners).toBe(1);
  });
});
