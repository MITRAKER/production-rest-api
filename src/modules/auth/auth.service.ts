import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { Errors } from '../../lib/errors.js';
import { invariant } from '../../lib/invariant.js';
import { generateToken, hashToken } from '../../lib/tokens.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function isUniqueViolation(err: unknown): boolean {
  // P2002 = a unique constraint was violated.
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export class AuthService {
  /**
   * Used when a login email doesn't exist: we still run argon2.verify against
   * this dummy hash so "unknown email" and "wrong password" take the same time.
   * Otherwise an attacker could time responses to discover which emails exist.
   * Created on first use and then reused (state kept inside the class, not
   * at module level: Power of Ten rule 6).
   */
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly app: FastifyInstance,
    private readonly opts: { accessTtl: string; refreshTtlDays: number },
  ) {}

  private get prisma() {
    return this.app.prisma;
  }

  async register(input: RegisterInput) {
    // argon2id: slow on purpose and memory-hard, which makes brute-forcing
    // stolen hashes on GPUs very expensive. It generates and stores a salt for us.
    // Hash BEFORE opening the transaction so we don't hold it open while hashing.
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    try {
      // One transaction: either the user AND their first session exist, or neither.
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: { email: input.email, name: input.name, passwordHash },
        });
        return { user, ...(await this.issueTokens(tx, user.id)) };
      });
    } catch (err) {
      // Letting the database enforce uniqueness avoids a race where two
      // signups both check "is this email free?" at the same time.
      if (isUniqueViolation(err)) throw Errors.emailTaken();
      throw err;
    }
  }

  async login(input: LoginInput) {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    this.dummyHash ??= argon2.hash('dummy-password-for-timing');
    const hash = user === null ? await this.dummyHash : user.passwordHash;
    const passwordMatches = await argon2.verify(hash, input.password);
    if (user === null || !passwordMatches) throw Errors.invalidCredentials();
    return { user, ...(await this.issueTokens(this.prisma, user.id)) };
  }

  /**
   * Refresh token rotation with reuse detection:
   * every refresh returns a NEW refresh token and revokes the old one.
   * If a revoked token is ever presented again, someone has a stolen copy,
   * so we revoke the whole family and force a fresh login.
   */
  async refresh(refreshToken: string) {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (stored === null) throw Errors.invalidRefreshToken();

    if (stored.revokedAt !== null) {
      await this.revokeFamily(stored.familyId);
      this.app.log.warn({ userId: stored.userId }, 'refresh token reuse detected; family revoked');
      throw Errors.invalidRefreshToken();
    }
    if (stored.expiresAt <= new Date()) throw Errors.invalidRefreshToken();

    const rotated = await this.rotate(stored);
    if (rotated === null) {
      // Someone used this token a split second before us: treat it as reuse.
      await this.revokeFamily(stored.familyId);
      throw Errors.invalidRefreshToken();
    }
    return rotated;
  }

  /** Logging out revokes the whole session (family). Always succeeds. */
  async logout(refreshToken: string) {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (stored !== null) await this.revokeFamily(stored.familyId);
  }

  /**
   * Revokes the old token and issues the next one in ONE transaction, so a
   * crash can't leave a session with no valid token. Returns null if the
   * token was already used by a concurrent request.
   */
  private async rotate(stored: { id: string; userId: string; familyId: string }) {
    return this.prisma.$transaction(async (tx) => {
      // Conditional update: only succeeds if nobody revoked it in the meantime.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) return null;

      const tokens = await this.issueTokens(tx, stored.userId, stored.familyId);

      // Power of Ten rule 5: after a rotation a session has exactly one live
      // refresh token. If not, there's a bug: throwing rolls everything back.
      const live = await tx.refreshToken.count({
        where: { familyId: stored.familyId, revokedAt: null },
      });
      invariant(
        live === 1,
        `session must have exactly 1 live refresh token, found ${String(live)}`,
      );
      return tokens;
    });
  }

  private async revokeFamily(familyId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokens(db: Db, userId: string, familyId: string = randomUUID()) {
    const accessToken = this.app.jwt.sign({ sub: userId });
    const refreshToken = generateToken();
    await db.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: hashToken(refreshToken),
        expiresAt: new Date(Date.now() + this.opts.refreshTtlDays * DAY_MS),
      },
    });
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer' as const,
      expiresIn: this.opts.accessTtl,
    };
  }
}
