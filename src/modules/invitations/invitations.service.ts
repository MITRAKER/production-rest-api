import type { FastifyInstance } from 'fastify';
import { Prisma } from '../../generated/prisma/client.js';
import { Errors } from '../../lib/errors.js';
import { lockUser } from '../../lib/locks.js';
import { generateToken, hashToken } from '../../lib/tokens.js';
import { outranks } from '../workspaces/workspaces.policy.js';
import {
  assertCanJoinAnotherWorkspace,
  lockWorkspace,
  requirePermission,
} from '../workspaces/workspaces.access.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Pending" = not accepted, not revoked, not expired. */
const pending = () => ({ acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } });

export interface InvitationOptions {
  ttlDays: number;
  maxPendingInvitations: number;
  maxMembersPerWorkspace: number;
  maxWorkspacesPerUser: number;
}

export class InvitationService {
  constructor(
    private readonly app: FastifyInstance,
    private readonly opts: InvitationOptions,
  ) {}

  private get prisma() {
    return this.app.prisma;
  }

  async create(
    workspaceId: string,
    actorId: string,
    input: { email: string; role: 'ADMIN' | 'MEMBER' },
  ) {
    return this.prisma.$transaction(async (tx) => {
      await lockWorkspace(tx, workspaceId);
      const actor = await requirePermission(tx, workspaceId, actorId, 'invitations:manage');
      if (!outranks(actor.role, input.role)) {
        throw Errors.forbidden(`Your role can't invite someone as ${input.role}`);
      }

      const alreadyMember = await tx.membership.findFirst({
        where: { workspaceId, user: { email: input.email } },
      });
      if (alreadyMember !== null) throw Errors.alreadyMember();

      const existing = await tx.invitation.findFirst({
        where: { workspaceId, email: input.email, ...pending() },
      });
      if (existing !== null) throw Errors.invitationPending();

      // Power of Ten rule 3: pending invitations can't pile up without limit.
      const pendingCount = await tx.invitation.count({ where: { workspaceId, ...pending() } });
      if (pendingCount >= this.opts.maxPendingInvitations) {
        throw Errors.limitReached(
          `A workspace can have at most ${String(this.opts.maxPendingInvitations)} pending invitations`,
        );
      }

      const token = generateToken();
      const invitation = await tx.invitation.create({
        data: {
          workspaceId,
          email: input.email,
          role: input.role,
          invitedById: actorId,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + this.opts.ttlDays * DAY_MS),
        },
      });
      // In a real product we'd email a link containing the token. Here the
      // inviter gets it once and shares it, like a "copy invite link" button.
      return { invitation, token };
    });
  }

  async listPending(workspaceId: string, actorId: string) {
    await requirePermission(this.prisma, workspaceId, actorId, 'invitations:manage');
    return this.prisma.invitation.findMany({
      where: { workspaceId, ...pending() },
      orderBy: { createdAt: 'desc' },
      // The quota already bounds this list; `take` makes the bound explicit.
      take: this.opts.maxPendingInvitations,
    });
  }

  async revoke(workspaceId: string, actorId: string, invitationId: string) {
    const actor = await requirePermission(this.prisma, workspaceId, actorId, 'invitations:manage');

    // Scope the lookup by BOTH ids. Looking up by invitationId alone would let
    // an admin of workspace A revoke invitations of workspace B just by
    // putting B's invitation id in A's URL (an "IDOR" bug).
    const invitation = await this.prisma.invitation.findFirst({
      where: { id: invitationId, workspaceId, acceptedAt: null, revokedAt: null },
    });
    if (invitation === null) throw Errors.invitationNotFound();
    if (!outranks(actor.role, invitation.role)) {
      throw Errors.forbidden(`Your role can't revoke an invitation for ${invitation.role}`);
    }

    // Conditional update: if the invitation was accepted a moment ago,
    // nothing changes and we report it as gone.
    const { count } = await this.prisma.invitation.updateMany({
      where: { id: invitationId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw Errors.invitationNotFound();
  }

  async accept(userId: string, token: string) {
    try {
      return await this.prisma.$transaction(async (tx) =>
        this.acceptInTransaction(tx, userId, token),
      );
    } catch (err) {
      // Belt and braces: the primary key on memberships is the final guard.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.alreadyMember();
      }
      throw err;
    }
  }

  private async acceptInTransaction(tx: Prisma.TransactionClient, userId: string, token: string) {
    const found = await tx.invitation.findUnique({ where: { tokenHash: hashToken(token) } });
    if (found === null) throw Errors.invitationNotFound();
    if (found.revokedAt !== null) throw Errors.invitationNotFound();

    // Lock order: the workspace first, then the user (see src/lib/locks.ts).
    await lockWorkspace(tx, found.workspaceId);
    await lockUser(tx, userId);

    // Re-read now that we hold the lock: it may have changed meanwhile.
    const invitation = await tx.invitation.findUniqueOrThrow({ where: { id: found.id } });
    if (invitation.revokedAt !== null) throw Errors.invitationNotFound();
    if (invitation.acceptedAt !== null || invitation.expiresAt <= new Date()) {
      throw Errors.invitationExpired();
    }

    // The token alone isn't enough: you must be logged in with the invited
    // email. That protects invitees who already have an account. Sign-up
    // doesn't verify emails yet, so for an invitee without one, whoever holds
    // the link can register that email first (SECURITY.md, known limitations).
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (user === null) throw Errors.unauthorized();
    if (user.email !== invitation.email) throw Errors.invitationEmailMismatch();

    const existing = await tx.membership.findUnique({
      where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId } },
    });
    if (existing !== null) throw Errors.alreadyMember();

    await this.assertRoomFor(tx, invitation.workspaceId, userId);

    // Conditional update: exactly one request can use this invitation,
    // even if it races with a revoke (which doesn't take the lock).
    const { count } = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (count === 0) throw Errors.invitationNotFound();

    const membership = await tx.membership.create({
      data: { workspaceId: invitation.workspaceId, userId, role: invitation.role },
      include: { workspace: true },
    });
    return { ...membership.workspace, role: membership.role };
  }

  /** Power of Ten rule 3: the workspace and the user both stay within their quotas. */
  private async assertRoomFor(tx: Prisma.TransactionClient, workspaceId: string, userId: string) {
    const members = await tx.membership.count({ where: { workspaceId } });
    if (members >= this.opts.maxMembersPerWorkspace) {
      throw Errors.limitReached(
        `A workspace can have at most ${String(this.opts.maxMembersPerWorkspace)} members`,
      );
    }
    await assertCanJoinAnotherWorkspace(tx, userId, this.opts.maxWorkspacesPerUser);
  }
}
