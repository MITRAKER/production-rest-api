import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  createProject,
  createTask,
  createTeamWithProject,
  invite,
  resetDb,
  signUp,
  warmUpPool,
} from './helpers.js';

/**
 * Tasks live inside a project. Every member can create, read and edit them.
 * Deleting one is for its creator, or an admin. Lists, filters and paging
 * are in task-lists.test.ts; the task quota is in limits.test.ts.
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

describe('POST .../projects/:projectId/tasks', () => {
  it('lets every member create a task, with sensible defaults', async () => {
    const team = await createTeamWithProject(app);

    const res = await team.member.api.post(team.tasksUrl, { title: '  Write the README  ' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      workspaceId: team.workspaceId,
      projectId: team.project.id,
      title: 'Write the README',
      description: '',
      status: 'TODO',
      priority: 'MEDIUM',
      dueDate: null,
      assigneeId: null,
      createdById: team.member.id,
    });
  });

  it('stores the due date as a calendar date, and assigns members', async () => {
    const team = await createTeamWithProject(app);

    const task = await createTask(team.owner.api, team.tasksUrl, {
      title: 'Launch',
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      dueDate: '2026-12-31',
      assigneeId: team.member.id,
    });
    expect(task).toMatchObject({
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      dueDate: '2026-12-31',
      assigneeId: team.member.id,
    });
    expect((await team.member.api.get(`${team.tasksUrl}/${task.id}`)).json().dueDate).toBe(
      '2026-12-31',
    );
  });

  it('only assigns tasks to members of the workspace', async () => {
    const team = await createTeamWithProject(app);
    for (const assigneeId of [team.outsider.id, '00000000-0000-4000-8000-000000000000']) {
      const res = await team.owner.api.post(team.tasksUrl, { title: 'X', assigneeId });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('ASSIGNEE_NOT_MEMBER');
    }
    expect(await app.prisma.task.count()).toBe(0);
  });

  it.each([
    ['an empty title', { title: ' ' }],
    ['a title that is too long', { title: 'x'.repeat(201) }],
    ['a description that is too long', { title: 'X', description: 'x'.repeat(5001) }],
    ['the NUL character, which Postgres text cannot hold', { title: 'X', description: 'a\u0000' }],
    ['an unknown status', { title: 'X', status: 'DOING' }],
    ['an unknown priority', { title: 'X', priority: 'URGENT' }],
    ['a day that does not exist', { title: 'X', dueDate: '2026-02-30' }],
    ['a date in another format', { title: 'X', dueDate: '31/12/2026' }],
    ['a timestamp instead of a date', { title: 'X', dueDate: '2026-12-31T10:00:00Z' }],
    ['a date before 1900', { title: 'X', dueDate: '1899-12-31' }],
    ['an assignee id that is not a uuid', { title: 'X', assigneeId: 'bob' }],
  ])('rejects %s', async (_label, payload) => {
    const team = await createTeamWithProject(app);
    const res = await team.owner.api.post(team.tasksUrl, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('answers 404 to outsiders and for unknown projects', async () => {
    const team = await createTeamWithProject(app);
    expect((await team.outsider.api.post(team.tasksUrl, { title: 'X' })).statusCode).toBe(404);
    const unknown = `${team.url}/projects/00000000-0000-4000-8000-000000000000/tasks`;
    const res = await team.owner.api.post(unknown, { title: 'X' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Project not found');

    const noWorkspace = `/workspaces/00000000-0000-4000-8000-000000000000/projects/${team.project.id}/tasks`;
    const missing = await team.owner.api.post(noWorkspace, { title: 'X' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe('Workspace not found');
  });
});

describe('GET .../tasks/:taskId', () => {
  it('lets members read a task; everyone else, and every wrong URL, gets 404', async () => {
    const team = await createTeamWithProject(app);
    const task = await createTask(team.owner.api, team.tasksUrl);
    const otherProject = await createProject(team.owner.api, team.workspaceId, 'Other');

    expect((await team.member.api.get(`${team.tasksUrl}/${task.id}`)).statusCode).toBe(200);
    expect((await team.outsider.api.get(`${team.tasksUrl}/${task.id}`)).statusCode).toBe(404);
    // The right task id under the wrong project: not found, not "moved".
    const wrongProject = `${team.url}/projects/${otherProject.id}/tasks/${task.id}`;
    expect((await team.owner.api.get(wrongProject)).statusCode).toBe(404);
    expect((await team.owner.api.patch(wrongProject, { title: 'Y' })).statusCode).toBe(404);
    expect((await team.owner.api.delete(wrongProject)).statusCode).toBe(404);
    expect((await team.owner.api.get(`${team.tasksUrl}/not-a-uuid`)).statusCode).toBe(400);
  });
});

describe('PATCH .../tasks/:taskId', () => {
  it('lets any member edit any task, changing only the fields they send', async () => {
    const team = await createTeamWithProject(app);
    const task = await createTask(team.owner.api, team.tasksUrl, {
      title: 'Ship it',
      description: 'Details',
      priority: 'HIGH',
    });

    const res = await team.member.api.patch(`${team.tasksUrl}/${task.id}`, { status: 'DONE' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      title: 'Ship it',
      description: 'Details',
      priority: 'HIGH',
      status: 'DONE',
      createdById: team.owner.id,
    });
    expect(res.json().updatedAt > task.updatedAt).toBe(true);
  });

  it('changes the title, description and priority', async () => {
    const team = await createTeamWithProject(app);
    const task = await createTask(team.owner.api, team.tasksUrl);

    const res = await team.admin.api.patch(`${team.tasksUrl}/${task.id}`, {
      title: '  Renamed  ',
      description: 'Now with details',
      priority: 'LOW',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      title: 'Renamed',
      description: 'Now with details',
      priority: 'LOW',
      status: 'TODO',
    });
  });

  it('sets, then clears, the due date and the assignee (null clears)', async () => {
    const team = await createTeamWithProject(app);
    const task = await createTask(team.owner.api, team.tasksUrl);
    const url = `${team.tasksUrl}/${task.id}`;

    const set = await team.owner.api.patch(url, {
      dueDate: '2027-01-15',
      assigneeId: team.admin.id,
    });
    expect(set.json()).toMatchObject({ dueDate: '2027-01-15', assigneeId: team.admin.id });

    const cleared = await team.owner.api.patch(url, { dueDate: null, assigneeId: null });
    expect(cleared.json()).toMatchObject({ dueDate: null, assigneeId: null });
  });

  it('needs at least one valid field, and only assigns members', async () => {
    const team = await createTeamWithProject(app);
    const task = await createTask(team.owner.api, team.tasksUrl);
    const url = `${team.tasksUrl}/${task.id}`;

    expect((await team.owner.api.patch(url, {})).statusCode).toBe(400);
    expect((await team.owner.api.patch(url, { title: '' })).statusCode).toBe(400);
    expect((await team.owner.api.patch(url, { dueDate: '2026-02-29' })).statusCode).toBe(400);
    const res = await team.owner.api.patch(url, { assigneeId: team.outsider.id });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ASSIGNEE_NOT_MEMBER');
  });

  it('answers 404 to outsiders and for unknown tasks', async () => {
    const team = await createTeamWithProject(app);
    const task = await createTask(team.owner.api, team.tasksUrl);
    const res = await team.outsider.api.patch(`${team.tasksUrl}/${task.id}`, { title: 'Mine' });
    expect(res.statusCode).toBe(404);
    const unknown = `${team.tasksUrl}/00000000-0000-4000-8000-000000000000`;
    expect((await team.owner.api.patch(unknown, { title: 'X' })).statusCode).toBe(404);
  });
});

describe('DELETE .../tasks/:taskId', () => {
  it('lets the creator delete their own task, even as a plain member', async () => {
    const team = await createTeamWithProject(app);
    const task = await createTask(team.member.api, team.tasksUrl);
    expect((await team.member.api.delete(`${team.tasksUrl}/${task.id}`)).statusCode).toBe(204);
    expect((await team.member.api.get(`${team.tasksUrl}/${task.id}`)).statusCode).toBe(404);
  });

  it("forbids members from deleting other people's tasks, but not admins", async () => {
    const team = await createTeamWithProject(app);
    const task = await createTask(team.owner.api, team.tasksUrl);
    const url = `${team.tasksUrl}/${task.id}`;

    expect((await team.member.api.delete(url)).statusCode).toBe(403);
    expect((await team.outsider.api.delete(url)).statusCode).toBe(404);
    expect((await team.admin.api.delete(url)).statusCode).toBe(204);
    expect((await team.admin.api.delete(url)).statusCode).toBe(404);
  });
});

describe('tasks and membership changes', () => {
  it('unassigns the tasks of a member who leaves or is removed, in that workspace only', async () => {
    const team = await createTeamWithProject(app);
    const carols = await createTask(team.owner.api, team.tasksUrl, {
      title: 'For Carol',
      assigneeId: team.member.id,
    });
    const bobs = await createTask(team.owner.api, team.tasksUrl, {
      title: 'For Bob',
      assigneeId: team.admin.id,
    });
    // Carol also belongs to another workspace, where she keeps her task.
    const created = await team.member.api.post('/workspaces', { name: 'Side' });
    const otherWorkspace = created.json<{ id: string }>().id;
    const sideProject = await createProject(team.member.api, otherWorkspace, 'Side');
    const sideTasks = `/workspaces/${otherWorkspace}/projects/${sideProject.id}/tasks`;
    const side = await createTask(team.member.api, sideTasks, {
      title: 'Mine',
      assigneeId: team.member.id,
    });

    // Carol leaves; Bob is removed by the owner.
    const left = await team.member.api.delete(`${team.url}/members/${team.member.id}`);
    expect(left.statusCode).toBe(204);
    const removed = await team.owner.api.delete(`${team.url}/members/${team.admin.id}`);
    expect(removed.statusCode).toBe(204);

    const task = async (url: string) => (await team.owner.api.get(url)).json();
    expect((await task(`${team.tasksUrl}/${carols.id}`)).assigneeId).toBeNull();
    expect((await task(`${team.tasksUrl}/${bobs.id}`)).assigneeId).toBeNull();
    const kept = await team.member.api.get(`${sideTasks}/${side.id}`);
    expect(kept.json().assigneeId).toBe(team.member.id);
  });

  it('never leaves a task assigned to someone who is no longer a member, even under a race', async () => {
    const team = await createTeamWithProject(app);
    const dana = await signUp(app, 'Dana');
    const existing = await createTask(team.owner.api, team.tasksUrl);

    for (let round = 0; round < 4; round++) {
      const { token } = await invite(team.owner.api, team.workspaceId, dana.email);
      expect((await dana.api.post('/invitations/accept', { token })).statusCode).toBe(200);

      await warmUpPool(app);
      // Four requests assign Dana while the owner removes her.
      const assignments = [
        ...[1, 2, 3].map(() =>
          team.admin.api.post(team.tasksUrl, { title: 'For Dana', assigneeId: dana.id }),
        ),
        team.admin.api.patch(`${team.tasksUrl}/${existing.id}`, { assigneeId: dana.id }),
      ];
      const removal = team.owner.api.delete(`${team.url}/members/${dana.id}`);
      const [removed, ...results] = await Promise.all([removal, ...assignments]);

      expect(removed.statusCode).toBe(204);
      // Each assignment either landed before the removal (and was then
      // undone by it) or came after it and was refused.
      for (const res of results) expect([200, 201, 400]).toContain(res.statusCode);
      expect(await app.prisma.task.count({ where: { assigneeId: dana.id } })).toBe(0);
    }
  });

  it('a task created while its project is deleted is either refused (404) or deleted with it', async () => {
    const team = await createTeamWithProject(app);

    await warmUpPool(app);
    const [deleted, ...created] = await Promise.all([
      team.admin.api.delete(team.projectUrl),
      ...[1, 2, 3, 4].map(() => team.member.api.post(team.tasksUrl, { title: 'Late' })),
    ]);
    expect(deleted.statusCode).toBe(204);
    for (const res of created) expect([201, 404]).toContain(res.statusCode);
    expect(await app.prisma.task.count()).toBe(0);
  });
});
