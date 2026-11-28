import { z } from 'zod';
import { Text } from '../../lib/text.js';

/**
 * Zod schemas describe the exact shape of each request and response.
 * Fastify uses them to reject bad input with a 400 *before* our code runs,
 * and to strip any field not listed from responses (so a passwordHash can
 * never leak by accident). TypeScript types are inferred from them too.
 */

// Bound the raw input (Power of Ten rule 3), trim and lowercase it,
// then check it's an email no longer than the 254 characters email allows.
export const Email = Text.max(320).trim().toLowerCase().pipe(z.email().max(254));

// Every input has an upper bound (Power of Ten rule 3). This one isn't what
// protects the CPU: argon2 costs about the same for any password length (it
// first condenses the password with a fast hash). The rate limit does that.
const Password = Text.min(8, 'must be at least 8 characters').max(128);

export const RegisterBody = z.object({
  email: Email,
  password: Password,
  name: Text.trim().min(1).max(100),
});

export const LoginBody = z.object({
  email: Email,
  // Not Text, on purpose. A login must accept every password that sign-up
  // ever accepted, or it locks those accounts out for good (there's no
  // password reset yet). Sign-up took any string before Text existed, and
  // that's harmless here: a password is only hashed and compared, never
  // stored, so the database never sees it.
  password: z.string().min(1).max(128),
});

export const RefreshBody = z.object({
  refreshToken: Text.min(1).max(200),
});

// The named schemas below (.meta id) are the ones an API client sees: they
// appear by name in the OpenAPI document (see src/plugins/openapi.ts).
export const PublicUser = z
  .object({
    id: z.uuid(),
    email: z.string(),
    name: z.string(),
    createdAt: z.date(),
  })
  .meta({ id: 'User', description: 'A user (never with their password hash)' });

export const AuthResponse = z
  .object({
    user: PublicUser,
    accessToken: z.string().describe('Send it as `Authorization: Bearer <accessToken>`'),
    refreshToken: z.string().describe('Trade it for new tokens at POST /auth/refresh, once'),
    tokenType: z.literal('Bearer'),
    expiresIn: z.string().describe('How long the access token lasts, such as "15m"'),
  })
  .meta({ id: 'AuthResponse', description: 'A user, and the tokens of their new session' });

export const TokenResponse = AuthResponse.omit({ user: true }).meta({
  id: 'TokenResponse',
  description: 'New tokens for the same session',
});

export type RegisterInput = z.infer<typeof RegisterBody>;
export type LoginInput = z.infer<typeof LoginBody>;
