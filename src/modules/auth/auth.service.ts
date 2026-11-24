import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { Prisma } from '../../generated/prisma/client.js';
import type { Db } from '../../lib/db.js';
import { Errors } from '../../lib/errors.js';
import { invariant } from '../../lib/invariant.js';
import { lockUser } from '../../lib/locks.js';
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
   *
   * `log` is the request's logger, so a warning carries the request's id.
   */
  async refresh(refreshToken: string, log: FastifyBaseLogger) {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (stored === null) throw Errors.invalidRefreshToken();

    if (stored.revokedAt !== null) return this.endStolenSession(stored, log);
    if (stored.expiresAt <= new Date()) throw Errors.invalidRefreshToken();

    const rotated = await this.rotate(stored);
    // Someone used this token a split second before us: that's reuse too.
    if (rotated === null) return this.endStolenSession(stored, log);
    return rotated;
  }

  /**
   * A refresh token was used twice, so a copy may be in the wrong hands: end
   * the whole session. The warning names the user and the session (never the
   * token), so someone can look into it.
   */
  private async endStolenSession(
    stored: { userId: string; familyId: string },
    log: FastifyBaseLogger,
  ): Promise<never> {
    await this.revokeFamily(stored);
    log.warn(
      { userId: stored.userId, familyId: stored.familyId },
      'refresh token reused: session revoked',
    );
    throw Errors.invalidRefreshToken();
  }

  /**
   * Logging out revokes the whole session (family), even if the token given
   * was already rotated: any token of the session identifies it. Always succeeds.
   */
  async logout(refreshToken: string) {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (stored !== null) await this.revokeFamily(stored);
  }

  /**
   * Revokes the old token and issues the next one in ONE transaction, so a
   * crash can't leave a session with no valid token. Returns null if the
   * token was already used by a concurrent request.
   */
  private async rotate(stored: { id: string; userId: string; familyId: string }) {
    return this.prisma.$transaction(async (tx) => {
      // Rotations and revocations of one user's sessions run one at a time
      // (see revokeFamily).
      await lockUser(tx, stored.userId);
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

  /**
   * Revokes every live token of a session. It takes the same user lock as
   * rotate() first. Without it, a revocation running while a refresh is
   * rotating the token would skip the new token (it doesn't exist yet when
   * the UPDATE starts), and the session would live on after a logout. With
   * it, the revocation waits for the rotation to commit, then sees and
   * revokes the new token too.
   */
  private async revokeFamily(stored: { userId: string; familyId: string }) {
    await this.prisma.$transaction(async (tx) => {
      await lockUser(tx, stored.userId);
      await tx.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
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
