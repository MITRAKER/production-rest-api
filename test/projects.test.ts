import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  createProject,
  createTask,
  createTeam,
  createTeamWithProject,
  type PageJson,
  type ProjectJson,
  resetDb,
  signUp,
} from './helpers.js';

/**
 * Projects live inside a workspace. Every member can read them; creating,
 * changing and deleting them is for admins and owners. Quotas and their
 * races are in limits.test.ts.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb(app);
});

describe('POST /workspaces/:workspaceId/projects', () => {
  it('lets owners and admins create projects', async () => {
    const team = await createTeam(app);

    const res = await team.owner.api.post(`${team.url}/projects`, {
      name: '  Website  ',
      description: 'The new site',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      workspaceId: team.workspaceId,
      name: 'Website',
      description: 'The new site',
      createdById: team.owner.id,
    });

    const byAdmin = await team.admin.api.post(`${team.url}/projects`, { name: 'App' });
    expect(byAdmin.statusCode).toBe(201);
    expect(byAdmin.json().description).toBe('');
  });

  it('forbids members (403) and hides the workspace from outsiders (404)', async () => {
    const team = await createTeam(app);
    const asMember = await team.member.api.post(`${team.url}/projects`, { name: 'X' });
    expect(asMember.statusCode).toBe(403);
    const asOutsider = await team.outsider.api.post(`${team.url}/projects`, { name: 'X' });
    expect(asOutsider.statusCode).toBe(404);
    const anonymous = await app.inject({
      method: 'POST',
      url: `${team.url}/projects`,
      payload: { name: 'X' },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it.each([
    ['an empty name', { name: '   ' }],
    ['a name that is too long', { name: 'x'.repeat(101) }],
    ['a description that is too long', { name: 'X', description: 'x'.repeat(2001) }],
    ['a name with the NUL character, which Postgres text cannot hold', { name: 'a\u0000b' }],
    ['no name', { description: 'only this' }],
  ])('rejects %s', async (_label, payload) => {
    const team = await createTeam(app);
    const res = await team.owner.api.post(`${team.url}/projects`, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /workspaces/:workspaceId/projects/:projectId', () => {
  it('lets every member read a project', async () => {
    const team = await createTeamWithProject(app);
    for (const user of [team.owner, team.admin, team.member]) {
      const res = await user.api.get(team.projectUrl);
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(team.project.id);
    }
  });

  it('answers 404 to outsiders, for unknown ids, and for malformed ids', async () => {
    const team = await createTeamWithProject(app);
    expect((await team.outsider.api.get(team.projectUrl)).statusCode).toBe(404);
    const unknown = `${team.url}/projects/00000000-0000-4000-8000-000000000000`;
    expect((await team.owner.api.get(unknown)).statusCode).toBe(404);
    expect((await team.owner.api.get(`${team.url}/projects/42`)).statusCode).toBe(400);
  });

  it("never reaches another workspace's project through your own workspace (IDOR)", async () => {
    const team = await createTeam(app);
    const eve = await signUp(app, 'Eve');
    const evesWorkspace = (await eve.api.post('/workspaces', { name: 'Eve Inc' })).json<{
      id: string;
    }>().id;
    const evesProject = await createProject(eve.api, evesWorkspace, 'Secret');

    // Alice is an owner, but of a different workspace than the project's.
    const url = `${team.url}/projects/${evesProject.id}`;
    expect((await team.owner.api.get(url)).statusCode).toBe(404);
    expect((await team.owner.api.patch(url, { name: 'Mine now' })).statusCode).toBe(404);
    expect((await team.owner.api.delete(url)).statusCode).toBe(404);
    expect((await team.owner.api.get(`${url}/tasks`)).statusCode).toBe(404);
    expect((await team.owner.api.post(`${url}/tasks`, { title: 'Hi' })).statusCode).toBe(404);

    const untouched = await eve.api.get(`/workspaces/${evesWorkspace}/projects/${evesProject.id}`);
    expect(untouched.json().name).toBe('Secret');
  });
});

describe('GET /workspaces/:workspaceId/projects', () => {
  /**
   * Projects created one minute apart. Created through the API in a quick
   * loop, two could share a millisecond, and then their order would depend
   * on their random ids.
   */
  async function teamWithProjects(count: number) {
    const team = await createTeam(app);
    await app.prisma.project.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        workspaceId: team.workspaceId,
        name: `Project ${String(i)}`,
        createdById: team.owner.id,
        createdAt: new Date(Date.UTC(2026, 10, 1, 10, i)),
      })),
    });
    const projects = await app.prisma.project.findMany({
      where: { workspaceId: team.workspaceId },
      orderBy: { createdAt: 'asc' },
    });
    return { ...team, projects };
  }

  it('lists projects page by page, oldest first', async () => {
    const team = await teamWithProjects(5);

    const first = await team.member.api.get(`${team.url}/projects?limit=2`);
    expect(first.statusCode).toBe(200);
    const page1 = first.json<PageJson<ProjectJson>>();
    expect(page1.data.map((p) => p.name)).toEqual(['Project 0', 'Project 1']);
    expect(page1.nextCursor).toEqual(expect.any(String));

    const page2 = (
      await team.member.api.get(`${team.url}/projects?limit=2&cursor=${String(page1.nextCursor)}`)
    ).json<PageJson<ProjectJson>>();
    expect(page2.data.map((p) => p.name)).toEqual(['Project 2', 'Project 3']);

    const page3 = (
      await team.member.api.get(`${team.url}/projects?limit=2&cursor=${String(page2.nextCursor)}`)
    ).json<PageJson<ProjectJson>>();
    expect(page3.data.map((p) => p.name)).toEqual(['Project 4']);
    expect(page3.nextCursor).toBeNull();
  });

  it('returns 20 per page by default', async () => {
    const team = await teamWithProjects(1);
    const res = await team.owner.api.get(`${team.url}/projects`);
    expect(res.json()).toEqual({
      data: [expect.objectContaining({ name: 'Project 0' })],
      nextCursor: null,
    });
  });

  it('keeps working when the project a cursor points at is deleted', async () => {
    const team = await teamWithProjects(4);
    const page1 = (await team.owner.api.get(`${team.url}/projects?limit=2`)).json<
      PageJson<ProjectJson>
    >();
    await team.owner.api.delete(`${team.url}/projects/${team.projects[1]?.id ?? ''}`);

    const page2 = await team.owner.api.get(
      `${team.url}/projects?limit=2&cursor=${String(page1.nextCursor)}`,
    );
    expect(page2.json().data.map((p: ProjectJson) => p.name)).toEqual(['Project 2', 'Project 3']);
  });

  it.each([
    ['limit=0', 'VALIDATION_ERROR'],
    ['limit=101', 'VALIDATION_ERROR'],
    ['limit=ten', 'VALIDATION_ERROR'],
    ['cursor=', 'VALIDATION_ERROR'],
    [`cursor=${'x'.repeat(513)}`, 'VALIDATION_ERROR'],
    ['cursor=not-a-cursor', 'INVALID_CURSOR'],
  ])('rejects %s', async (query, code) => {
    const team = await teamWithProjects(1);
    const res = await team.owner.api.get(`${team.url}/projects?${query}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
  });

  it('rejects a cursor from another list, even one sorted the same way', async () => {
    const team = await createTeamWithProject(app);
    await createTask(team.owner.api, team.tasksUrl);
    await createTask(team.owner.api, team.tasksUrl);
    const tasksUrl = `${team.tasksUrl}?limit=1&sort=createdAt&order=asc`;
    const tasks = (await team.owner.api.get(tasksUrl)).json<PageJson<unknown>>();

    // The project list of another workspace, which Alice owns too.
    const other = (await team.owner.api.post('/workspaces', { name: 'Other' })).json<{
      id: string;
    }>().id;
    await createProject(team.owner.api, other, 'A');
    await createProject(team.owner.api, other, 'B');
    const projectsUrl = `/workspaces/${other}/projects?limit=1`;
    const projects = (await team.owner.api.get(projectsUrl)).json<PageJson<unknown>>();

    for (const cursor of [tasks.nextCursor, projects.nextCursor]) {
      const res = await team.owner.api.get(`${team.url}/projects?cursor=${String(cursor)}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_CURSOR');
    }
  });

  it('answers 404 to outsiders', async () => {
    const team = await teamWithProjects(1);
    expect((await team.outsider.api.get(`${team.url}/projects`)).statusCode).toBe(404);
  });
});

describe('PATCH /workspaces/:workspaceId/projects/:projectId', () => {
  it('lets admins change only the fields they send', async () => {
    const team = await createTeamWithProject(app);
    await team.owner.api.patch(team.projectUrl, { description: 'Before' });

    const res = await team.admin.api.patch(team.projectUrl, { name: 'Website v2' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Website v2', description: 'Before' });
    expect(res.json().updatedAt > team.project.updatedAt).toBe(true);
  });

  it('forbids members (403) and hides the project from outsiders (404)', async () => {
    const team = await createTeamWithProject(app);
    expect((await team.member.api.patch(team.projectUrl, { name: 'X' })).statusCode).toBe(403);
    expect((await team.outsider.api.patch(team.projectUrl, { name: 'X' })).statusCode).toBe(404);
  });

  it('needs at least one valid field', async () => {
    const team = await createTeamWithProject(app);
    expect((await team.owner.api.patch(team.projectUrl, {})).statusCode).toBe(400);
    expect((await team.owner.api.patch(team.projectUrl, { color: 'red' })).statusCode).toBe(400);
    expect((await team.owner.api.patch(team.projectUrl, { name: '' })).statusCode).toBe(400);
  });
});

describe('DELETE /workspaces/:workspaceId/projects/:projectId', () => {
  it('lets admins delete a project, and its tasks go with it', async () => {
    const team = await createTeamWithProject(app);
    const task = await createTask(team.member.api, team.tasksUrl);

    expect((await team.member.api.delete(team.projectUrl)).statusCode).toBe(403);
    expect((await team.outsider.api.delete(team.projectUrl)).statusCode).toBe(404);
    expect((await team.admin.api.delete(team.projectUrl)).statusCode).toBe(204);

    expect((await team.owner.api.get(team.projectUrl)).statusCode).toBe(404);
    expect((await team.owner.api.get(`${team.tasksUrl}/${task.id}`)).statusCode).toBe(404);
    expect(await app.prisma.task.count()).toBe(0);
    expect((await team.admin.api.delete(team.projectUrl)).statusCode).toBe(404);
  });

  it('deleting the workspace deletes its projects and their tasks', async () => {
    const team = await createTeamWithProject(app);
    await createTask(team.owner.api, team.tasksUrl);

    expect((await team.owner.api.delete(team.url)).statusCode).toBe(204);
    expect(await app.prisma.project.count()).toBe(0);
    expect(await app.prisma.task.count()).toBe(0);
  });
});
