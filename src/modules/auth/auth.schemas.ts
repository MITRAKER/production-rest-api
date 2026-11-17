import { z } from 'zod';

/**
 * Zod schemas describe the exact shape of each request and response.
 * Fastify uses them to reject bad input with a 400 *before* our code runs,
 * and to strip any field not listed from responses (so a passwordHash can
 * never leak by accident). TypeScript types are inferred from them too.
 */

// Trim and lowercase first, then check it's an email.
const Email = z.string().trim().toLowerCase().pipe(z.email().max(254));

// Upper bound matters: hashing a 1 MB "password" is a cheap way to burn our CPU.
const Password = z.string().min(8, 'must be at least 8 characters').max(128);

export const RegisterBody = z.object({
  email: Email,
  password: Password,
  name: z.string().trim().min(1).max(100),
});

export const LoginBody = z.object({
  email: Email,
  password: z.string().min(1).max(128),
});

export const RefreshBody = z.object({
  refreshToken: z.string().min(1).max(200),
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
