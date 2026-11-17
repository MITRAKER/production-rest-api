import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { hashToken } from '../src/lib/tokens.js';
import { buildTestApp, client, createTeam, invite, resetDb, signUp } from './helpers.js';

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

describe('POST /workspaces/:workspaceId/invitations', () => {
  it('returns the token once and stores only its hash', async () => {
    const team = await createTeam(app);
    const res = await team.owner.api.post(`${team.url}/invitations`, {
      email: '  Erin@Example.com ',
      role: 'ADMIN',
    });
    expect(res.statusCode).toBe(201);
    const { invitation, token } = res.json();
    expect(invitation).toMatchObject({ email: 'erin@example.com', role: 'ADMIN' });
    expect(token).toEqual(expect.any(String));

    const row = await app.prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toBe(hashToken(token));
  });

  it('defaults to the MEMBER role', async () => {
    const team = await createTeam(app);
    const res = await team.owner.api.post(`${team.url}/invitations`, { email: 'erin@example.com' });
    expect(res.json().invitation.role).toBe('MEMBER');
  });

  it('only lets you invite to a role below your own', async () => {
    const team = await createTeam(app);
    const adminInvitesMember = await team.admin.api.post(`${team.url}/invitations`, {
      email: 'erin@example.com',
      role: 'MEMBER',
    });
    const adminInvitesAdmin = await team.admin.api.post(`${team.url}/invitations`, {
      email: 'frank@example.com',
      role: 'ADMIN',
    });
    expect(adminInvitesMember.statusCode).toBe(201);
    expect(adminInvitesAdmin.statusCode).toBe(403);
  });

  it('never invites anyone as OWNER (400 for everyone, even owners)', async () => {
    const team = await createTeam(app);
    const res = await team.owner.api.post(`${team.url}/invitations`, {
      email: 'erin@example.com',
      role: 'OWNER',
    });
    expect(res.statusCode).toBe(400);
  });

  it('forbids members (403) and hides the workspace from outsiders (404)', async () => {
    const team = await createTeam(app);
    const payload = { email: 'erin@example.com' };
    expect((await team.member.api.post(`${team.url}/invitations`, payload)).statusCode).toBe(403);
    expect((await team.outsider.api.post(`${team.url}/invitations`, payload)).statusCode).toBe(404);
  });

  it('refuses to invite someone who is already a member', async () => {
    const team = await createTeam(app);
    const res = await team.owner.api.post(`${team.url}/invitations`, {
      email: 'CAROL@example.com',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_MEMBER');
  });

  it('allows one pending invitation per email; revoking or expiry frees the slot', async () => {
    const team = await createTeam(app);
    const first = await invite(team.owner.api, team.workspaceId, 'erin@example.com');

    const duplicate = await team.owner.api.post(`${team.url}/invitations`, {
      email: 'erin@example.com',
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('INVITATION_PENDING');

    await team.owner.api.delete(`${team.url}/invitations/${first.invitation.id}`);
    const second = await invite(team.owner.api, team.workspaceId, 'erin@example.com');

    await app.prisma.invitation.update({
      where: { id: second.invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await invite(team.owner.api, team.workspaceId, 'erin@example.com');
  });
});

describe('GET /workspaces/:workspaceId/invitations', () => {
  it('lists only pending invitations, for admins and owners', async () => {
    const team = await createTeam(app);
    const pending = await invite(team.owner.api, team.workspaceId, 'erin@example.com');
    const revoked = await invite(team.owner.api, team.workspaceId, 'frank@example.com');
    await team.owner.api.delete(`${team.url}/invitations/${revoked.invitation.id}`);
    const expired = await invite(team.owner.api, team.workspaceId, 'gina@example.com');
    await app.prisma.invitation.update({
      where: { id: expired.invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await team.admin.api.get(`${team.url}/invitations`);
    expect(res.statusCode).toBe(200);
    // Bob's and Carol's invitations were accepted in createTeam, so they're gone too.
    expect(res.json().data.map((i: { id: string }) => i.id)).toEqual([pending.invitation.id]);

    expect((await team.member.api.get(`${team.url}/invitations`)).statusCode).toBe(403);
    expect((await team.outsider.api.get(`${team.url}/invitations`)).statusCode).toBe(404);
  });
});

describe('DELETE /workspaces/:workspaceId/invitations/:invitationId', () => {
  it('revokes an invitation so its token stops working', async () => {
    const team = await createTeam(app);
    const erin = await signUp(app, 'Erin');
    const { invitation, token } = await invite(team.admin.api, team.workspaceId, erin.email);

    expect(
      (await team.admin.api.delete(`${team.url}/invitations/${invitation.id}`)).statusCode,
    ).toBe(204);
    const accept = await erin.api.post('/invitations/accept', { token });
    expect(accept.statusCode).toBe(404);
  });

  it("doesn't let an admin revoke an invitation for a role equal to theirs", async () => {
    const team = await createTeam(app);
    const { invitation } = await invite(
      team.owner.api,
      team.workspaceId,
      'erin@example.com',
      'ADMIN',
    );
    const res = await team.admin.api.delete(`${team.url}/invitations/${invitation.id}`);
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for an invitation that was already accepted', async () => {
    const team = await createTeam(app);
    const erin = await signUp(app, 'Erin');
    const { invitation, token } = await invite(team.owner.api, team.workspaceId, erin.email);
    await erin.api.post('/invitations/accept', { token });

    const res = await team.owner.api.delete(`${team.url}/invitations/${invitation.id}`);
    expect(res.statusCode).toBe(404);
  });

  it("can't touch another workspace's invitation through your own workspace's URL (IDOR)", async () => {
    const team = await createTeam(app);
    const { invitation } = await invite(team.owner.api, team.workspaceId, 'erin@example.com');

    // Dave owns a different workspace and tries to revoke Acme's invitation via it.
    const other = await team.outsider.api.post('/workspaces', { name: 'Dave Co' });
    const res = await team.outsider.api.delete(
      `/workspaces/${other.json<{ id: string }>().id}/invitations/${invitation.id}`,
    );
    expect(res.statusCode).toBe(404);

    const row = await app.prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(row.revokedAt).toBeNull();
  });

  it('returns 404 for an unknown invitation id', async () => {
    const team = await createTeam(app);
    const res = await team.owner.api.delete(`${team.url}/invitations/${randomUUID()}`);
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /invitations/accept', () => {
  it('adds the invitee with the invited role', async () => {
    const team = await createTeam(app);
    const erin = await signUp(app, 'Erin');
    const { token } = await invite(team.owner.api, team.workspaceId, erin.email, 'ADMIN');

    const res = await erin.api.post('/invitations/accept', { token });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: team.workspaceId, name: 'Acme', role: 'ADMIN' });
    expect((await erin.api.get(team.url)).statusCode).toBe(200);
  });

  it('works for people who sign up after being invited', async () => {
    const team = await createTeam(app);
    const { token } = await invite(team.owner.api, team.workspaceId, 'erin@example.com');
    const erin = await signUp(app, 'Erin');
    expect((await erin.api.post('/invitations/accept', { token })).statusCode).toBe(200);
  });

  it('refuses a different account than the one invited, and the link stays valid', async () => {
    const team = await createTeam(app);
    const erin = await signUp(app, 'Erin');
    const { token } = await invite(team.owner.api, team.workspaceId, erin.email);

    // Dave got hold of Erin's link.
    const stolen = await team.outsider.api.post('/invitations/accept', { token });
    expect(stolen.statusCode).toBe(403);
    expect(stolen.json().error.code).toBe('INVITATION_EMAIL_MISMATCH');

    expect((await erin.api.post('/invitations/accept', { token })).statusCode).toBe(200);
  });

  it('can only be used once', async () => {
    const team = await createTeam(app);
    const erin = await signUp(app, 'Erin');
    const { token } = await invite(team.owner.api, team.workspaceId, erin.email);
    await erin.api.post('/invitations/accept', { token });

    const again = await erin.api.post('/invitations/accept', { token });
    expect(again.statusCode).toBe(410);
    expect(again.json().error.code).toBe('INVITATION_EXPIRED');
  });

  it('rejects an expired invitation with 410', async () => {
    const team = await createTeam(app);
    const erin = await signUp(app, 'Erin');
    const { invitation, token } = await invite(team.owner.api, team.workspaceId, erin.email);
    await app.prisma.invitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await erin.api.post('/invitations/accept', { token })).statusCode).toBe(410);
  });

  it('rejects an unknown token with 404 and requires authentication', async () => {
    const erin = await signUp(app, 'Erin');
    expect((await erin.api.post('/invitations/accept', { token: 'made-up' })).statusCode).toBe(404);
    expect((await client(app).post('/invitations/accept', { token: 'x' })).statusCode).toBe(401);
  });

  it('rejects someone who joined in the meantime', async () => {
    const team = await createTeam(app);
    const erin = await signUp(app, 'Erin');
    const first = await invite(team.owner.api, team.workspaceId, erin.email);
    await erin.api.post('/invitations/accept', { token: first.token });

    // Erin leaves, gets invited again, but is re-added another way before accepting.
    await erin.api.delete(`${team.url}/members/${erin.id}`);
    const second = await invite(team.owner.api, team.workspaceId, erin.email);
    const third = await team.owner.api.post(`${team.url}/invitations`, { email: erin.email });
    expect(third.statusCode).toBe(409); // still pending
    await app.prisma.membership.create({
      data: { workspaceId: team.workspaceId, userId: erin.id, role: 'MEMBER' },
    });

    const res = await erin.api.post('/invitations/accept', { token: second.token });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ALREADY_MEMBER');
  });

  it('lets exactly one of two simultaneous accepts succeed', async () => {
    const team = await createTeam(app);
    const erin = await signUp(app, 'Erin');
    const { token } = await invite(team.owner.api, team.workspaceId, erin.email);

    const results = await Promise.all([
      erin.api.post('/invitations/accept', { token }),
      erin.api.post('/invitations/accept', { token }),
    ]);
    expect(results.map((r) => r.statusCode).sort((a, b) => a - b)).toEqual([200, 410]);
    const memberships = await app.prisma.membership.count({ where: { userId: erin.id } });
    expect(memberships).toBe(1);
  });
});
