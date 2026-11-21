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
  password: Text.min(1).max(128),
});

export const RefreshBody = z.object({
  refreshToken: Text.min(1).max(200),
});

export const PublicUser = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  createdAt: z.date(),
});

export const AuthResponse = z.object({
  user: PublicUser,
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.string(),
});

export const TokenResponse = AuthResponse.omit({ user: true });

export type RegisterInput = z.infer<typeof RegisterBody>;
export type LoginInput = z.infer<typeof LoginBody>;
