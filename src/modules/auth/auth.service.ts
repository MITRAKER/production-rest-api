import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import { Prisma } from '../../generated/prisma/client.js';
import { Errors } from '../../lib/errors.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Refresh tokens are random strings; we store only their SHA-256 hash. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Used when a login email doesn't exist: we still run argon2.verify against
 * this dummy hash so "unknown email" and "wrong password" take the same time.
 * Otherwise an attacker could time responses to discover which emails exist.
 */
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= argon2.hash('dummy-password-for-timing'));

export class AuthService {
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
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    try {
      const user = await this.prisma.user.create({
        data: { email: input.email, name: input.name, passwordHash },
      });
      return { user, ...(await this.issueTokens(user.id)) };
    } catch (err) {
      // P2002 = unique constraint violated. Letting the database enforce
      // uniqueness avoids a race where two signups check "free?" at the same time.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw Errors.emailTaken();
      }
      throw err;
    }
  }

  async login(input: LoginInput) {
    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    const ok = await argon2.verify(user?.passwordHash ?? (await getDummyHash()), input.password);
    if (!user || !ok) throw Errors.invalidCredentials();
    return { user, ...(await this.issueTokens(user.id)) };
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
    if (!stored) throw Errors.invalidRefreshToken();

    if (stored.revokedAt) {
      await this.revokeFamily(stored.familyId);
      this.app.log.warn({ userId: stored.userId }, 'refresh token reuse detected; family revoked');
      throw Errors.invalidRefreshToken();
    }
    if (stored.expiresAt <= new Date()) throw Errors.invalidRefreshToken();

    // Conditional update: only succeeds if nobody revoked it in the meantime.
    // This makes two simultaneous refreshes with the same token safe.
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) {
      await this.revokeFamily(stored.familyId);
      throw Errors.invalidRefreshToken();
    }

    return this.issueTokens(stored.userId, stored.familyId);
  }

  /** Logging out revokes the whole session (family). Always succeeds. */
  async logout(refreshToken: string) {
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(refreshToken) },
    });
    if (stored) await this.revokeFamily(stored.familyId);
  }

  private async revokeFamily(familyId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async issueTokens(userId: string, familyId: string = randomUUID()) {
    const accessToken = this.app.jwt.sign({ sub: userId });
    const refreshToken = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
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
