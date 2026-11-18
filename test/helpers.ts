import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

export async function buildTestApp(overrides: Record<string, string> = {}) {
  return buildApp(loadEnv({ ...process.env, ...overrides }));
}

/** Empties every table so each test starts from a clean, known state. */
export async function resetDb(app: FastifyInstance) {
  await app.prisma.$executeRawUnsafe('TRUNCATE TABLE refresh_tokens, users RESTART IDENTITY CASCADE');
}

export const alice = { email: 'alice@example.com', password: 'correct horse battery', name: 'Alice' };

export async function registerUser(app: FastifyInstance, user = alice) {
  const res = await app.inject({ method: 'POST', url: '/auth/register', payload: user });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  return res.json() as { accessToken: string; refreshToken: string; user: { id: string } };
}
