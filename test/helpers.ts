import type { FastifyInstance } from 'fastify';
import { buildApp, type BuildOptions } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';

export async function buildTestApp(overrides: Record<string, string> = {}, options?: BuildOptions) {
  return buildApp(loadEnv({ ...process.env, ...overrides }), options);
}

/**
 * Empties every table so each test starts from a clean, known state.
 * It asks Postgres for the table list, so new tables are reset automatically.
 */
export async function resetDb(app: FastifyInstance) {
  const tables = await app.prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await app.prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Opens several database connections before a race test.
 *
 * Call it right before a `Promise.all` of requests that are meant to race.
 * Otherwise only one connection is open: the first request takes it and the
 * others wait while new connections are set up, so they reach the database
 * one after the other and never actually race. Such a test passes even
 * without the lock it is supposed to check.
 */
export async function warmUpPool(app: FastifyInstance, connections = 6) {
  await Promise.all(Array.from({ length: connections }, () => app.prisma.$queryRaw`SELECT 1`));
}

/** Resolves after `ms` milliseconds. */
export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TestUser {
  email: string;
  password: string;
  name: string;
}

export const alice: TestUser = {
  email: 'alice@example.com',
  password: 'correct horse battery',
  name: 'Alice',
};

export function makeUser(name: string): TestUser {
  return { email: `${name.toLowerCase()}@example.com`, password: 'correct horse battery', name };
}

export async function registerUser(app: FastifyInstance, user: TestUser = alice) {
  const res = await app.inject({ method: 'POST', url: '/auth/register', payload: user });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  return res.json<{ accessToken: string; refreshToken: string; user: { id: string } }>();
}

/** A tiny HTTP client bound to one user's access token. */
export function client(app: FastifyInstance, accessToken?: string) {
  const headers = accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` };
  const send = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    payload === undefined
      ? app.inject({ method, url, headers })
      : app.inject({ method, url, headers, payload });
  return {
    get: (url: string) => send('GET', url),
    post: (url: string, payload?: object) => send('POST', url, payload),
    patch: (url: string, payload?: object) => send('PATCH', url, payload),
    delete: (url: string) => send('DELETE', url),
  };
}

export type Client = ReturnType<typeof client>;

/** Registers a user and returns their id, email and a client logged in as them. */
export async function signUp(app: FastifyInstance, name: string) {
  const user = makeUser(name);
  const { accessToken, user: created } = await registerUser(app, user);
  return { id: created.id, email: user.email, api: client(app, accessToken) };
}

export async function invite(api: Client, workspaceId: string, email: string, role = 'MEMBER') {
  const res = await api.post(`/workspaces/${workspaceId}/invitations`, { email, role });
  if (res.statusCode !== 201) throw new Error(`invite failed: ${res.body}`);
  return res.json<{ invitation: { id: string; email: string; role: string }; token: string }>();
}

type SignedUp = Awaited<ReturnType<typeof signUp>>;

/**
 * The standard cast for authorization tests, in workspace "Acme":
 * Alice (OWNER), Bob (ADMIN), Carol (MEMBER), and Dave who is not a member.
 * Bob and Carol join through the real invitation flow.
 */
export async function createTeam(app: FastifyInstance) {
  const owner = await signUp(app, 'Alice');
  const admin = await signUp(app, 'Bob');
  const member = await signUp(app, 'Carol');
  const outsider = await signUp(app, 'Dave');

  const created = await owner.api.post('/workspaces', { name: 'Acme' });
  const workspaceId = created.json<{ id: string }>().id;

  const join = async (user: SignedUp, role: string) => {
    const { token } = await invite(owner.api, workspaceId, user.email, role);
    const res = await user.api.post('/invitations/accept', { token });
    if (res.statusCode !== 200) throw new Error(`accept failed: ${res.body}`);
  };
  await join(admin, 'ADMIN');
  await join(member, 'MEMBER');

  return { workspaceId, url: `/workspaces/${workspaceId}`, owner, admin, member, outsider };
}

/** A project as the API returns it. */
export interface ProjectJson {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A task as the API returns it. */
export interface TaskJson {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  dueDate: string | null;
  assigneeId: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One page of a paginated list. */
export interface PageJson<T> {
  data: T[];
  nextCursor: string | null;
}

export async function createProject(api: Client, workspaceId: string, name = 'Website') {
  const res = await api.post(`/workspaces/${workspaceId}/projects`, { name });
  if (res.statusCode !== 201) throw new Error(`create project failed: ${res.body}`);
  return res.json<ProjectJson>();
}

export async function createTask(
  api: Client,
  tasksUrl: string,
  body: object = { title: 'A task' },
) {
  const res = await api.post(tasksUrl, body);
  if (res.statusCode !== 201) throw new Error(`create task failed: ${res.body}`);
  return res.json<TaskJson>();
}

/** The standard team (see createTeam), plus a project "Website" in their workspace. */
export async function createTeamWithProject(app: FastifyInstance) {
  const team = await createTeam(app);
  const project = await createProject(team.owner.api, team.workspaceId);
  const projectUrl = `${team.url}/projects/${project.id}`;
  return { ...team, project, projectUrl, tasksUrl: `${projectUrl}/tasks` };
}
