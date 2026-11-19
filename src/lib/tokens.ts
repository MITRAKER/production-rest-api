import { createHash, randomBytes } from 'node:crypto';

/**
 * Secret tokens (refresh tokens, invitation tokens) are 32 random bytes:
 * 256 bits of randomness, far too many to guess.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * We store only a SHA-256 hash of each token. If the database leaks, the
 * hashes can't be used as tokens. A fast hash is fine here (unlike passwords)
 * because the input is random, so there is nothing to brute-force.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
