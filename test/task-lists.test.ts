import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  type Client,
  createProject,
  createTask,
  createTeamWithProject,
  type PageJson,
  resetDb,
  type TaskJson,
  warmUpPool,
} from './helpers.js';

/**
 * GET .../tasks: filtering, sorting and cursor pagination.
 *
 * The paging tests insert tasks with chosen timestamps and due dates
 * (including ties and missing due dates), then walk through every page and
 * compare the result with the order computed here, in plain JavaScript.
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

type Team = Awaited<ReturnType<typeof createTeamWithProject>>;

async function list(api: Client, url: string) {
  const res = await api.get(url);
  if (res.statusCode !== 200) throw new Error(`list failed: ${res.body}`);
  return res.json<PageJson<TaskJson>>();
}

/** Follows nextCursor until the last page; returns every task, in the order received. */
async function walk(api: Client, tasksUrl: string, query: string) {
  const tasks: TaskJson[] = [];
  let cursor: string | null = null;
  // Power of Ten rule 2 applies to tests too: a bug can't make this loop forever.
  for (let page = 0; page < 100; page++) {
    const after: string = cursor === null ? '' : `&cursor=${cursor}`;
    const body = await list(api, `${tasksUrl}?${query}${after}`);
    tasks.push(...body.data);
    cursor = body.nextCursor;
    if (cursor === null) return tasks;
  }
  throw new Error('more than 100 pages');
}

const titles = (tasks: TaskJson[]) => tasks.map((t) => t.title);
const sorted = (values: string[]) => [...values].sort((a, b) => a.localeCompare(b));

describe('filters', () => {
  async function seed(team: Team) {
    const make = (body: object) => createTask(team.owner.api, team.tasksUrl, body);
    await make({ title: 'Plan', status: 'DONE', priority: 'LOW', dueDate: '2026-11-30' });
    await make({ title: 'Design', status: 'IN_PROGRESS', dueDate: '2026-12-01' });
    await make({
      title: 'Build',
      priority: 'HIGH',
      assigneeId: team.admin.id,
      dueDate: '2026-12-31',
    });
    await make({ title: 'Test', priority: 'HIGH', assigneeId: team.member.id });
    await make({ title: '100% done', status: 'DONE' });
    await make({ title: '100 apples' });
    await make({ title: 'a_b' });
    await make({ title: 'axb' });
  }

  // Which tasks match, in alphabetical order: the tasks above are created
  // quickly, two can share a millisecond, and then the order the API returns
  // depends on their random ids. Sorting is tested in the next section.
  it.each([
    ['status=DONE', ['100% done', 'Plan']],
    ['status=DONE,IN_PROGRESS', ['100% done', 'Design', 'Plan']],
    ['priority=HIGH', ['Build', 'Test']],
    ['priority=LOW,HIGH&status=TODO', ['Build', 'Test']],
    ['assigneeId=none&priority=HIGH', []],
    ['dueFrom=2026-12-01&dueTo=2026-12-31', ['Build', 'Design']],
    ['dueFrom=2026-12-31', ['Build']],
    ['dueTo=2026-11-30', ['Plan']],
    ['q=BUILD', ['Build']],
    ['q=100%25', ['100% done']],
    ['q=a_b', ['a_b']],
    ['q=e&status=TODO', ['100 apples', 'Test']],
  ])('%s', async (query, expected) => {
    const team = await createTeamWithProject(app);
    await seed(team);
    const page = await list(team.member.api, `${team.tasksUrl}?${query}`);
    expect(sorted(titles(page.data))).toEqual(expected);
  });

  it('filters by assignee', async () => {
    const team = await createTeamWithProject(app);
    await seed(team);
    const forCarol = await list(team.owner.api, `${team.tasksUrl}?assigneeId=${team.member.id}`);
    expect(titles(forCarol.data)).toEqual(['Test']);
    const unassigned = await list(team.owner.api, `${team.tasksUrl}?assigneeId=none`);
    expect(unassigned.data).toHaveLength(6);
  });

  it.each([
    'status=NOPE',
    'status=',
    'priority=HIGH,HIGH,HIGH,HIGH',
    'assigneeId=bob',
    'dueFrom=2026-12-31&dueTo=2026-12-01',
    'dueFrom=tomorrow',
    'q=%20%20',
    'q=a%00b',
    `q=${'x'.repeat(101)}`,
    'sort=title',
    'sort=createdAt&order=up',
  ])('rejects %s', async (query) => {
    const team = await createTeamWithProject(app);
    const res = await team.owner.api.get(`${team.tasksUrl}?${query}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('answers 404 to outsiders and for unknown projects', async () => {
    const team = await createTeamWithProject(app);
    expect((await team.outsider.api.get(team.tasksUrl)).statusCode).toBe(404);
    const unknown = `${team.url}/projects/00000000-0000-4000-8000-000000000000/tasks`;
    const res = await team.owner.api.get(unknown);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe('Project not found');
  });
});

describe('sorting and paging', () => {
  /** What the database holds for one task, in the API's format. */
  interface Row {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    dueDate: string | null;
  }

  // Ties on purpose: the same createdAt three times, the same updatedAt
  // twice, the same due date three times, and four tasks without a due date.
  const SEEDS: [string, string, string, string | null][] = [
    ['t1', '2026-11-01T10:00:00.000Z', '2026-11-05T10:00:00.000Z', '2026-12-01'],
    ['t2', '2026-11-01T10:00:00.000Z', '2026-11-02T10:00:00.000Z', null],
    ['t3', '2026-11-01T10:00:00.000Z', '2026-11-09T10:00:00.000Z', '2026-12-01'],
    ['t4', '2026-11-02T10:00:00.000Z', '2026-11-02T10:00:00.000Z', '2026-11-15'],
    ['t5', '2026-11-03T10:00:00.000Z', '2026-11-07T10:00:00.000Z', null],
    ['t6', '2026-11-04T10:00:00.000Z', '2026-11-04T10:00:00.000Z', '2027-01-31'],
    ['t7', '2026-11-05T10:00:00.000Z', '2026-11-06T10:00:00.000Z', null],
    ['t8', '2026-11-06T10:00:00.000Z', '2026-11-08T10:00:00.000Z', '2026-12-01'],
    ['t9', '2026-11-07T10:00:00.000Z', '2026-11-10T10:00:00.000Z', null],
    ['t10', '2026-11-08T10:00:00.000Z', '2026-11-11T10:00:00.000Z', '2026-10-01'],
  ];

  async function seed(team: Team): Promise<Row[]> {
    await app.prisma.task.createMany({
      data: SEEDS.map(([title, createdAt, updatedAt, dueDate]) => ({
        workspaceId: team.workspaceId,
        projectId: team.project.id,
        title,
        createdAt: new Date(createdAt),
        updatedAt: new Date(updatedAt),
        dueDate: dueDate === null ? null : new Date(`${dueDate}T00:00:00.000Z`),
      })),
    });
    const rows = await app.prisma.task.findMany({ where: { projectId: team.project.id } });
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      dueDate: r.dueDate === null ? null : r.dueDate.toISOString().slice(0, 10),
    }));
  }

  /** The order the API must return: by the field, then by id; tasks without a due date last. */
  function expectedOrder(rows: Row[], sort: 'createdAt' | 'updatedAt' | 'dueDate', order: string) {
    const direction = order === 'asc' ? 1 : -1;
    const byIdThenField = [...rows].sort((a, b) => {
      const [x, y] = [a[sort], b[sort]];
      if (x === y) return a.id < b.id ? -direction : direction;
      if (x === null) return 1;
      if (y === null) return -1;
      return x < y ? -direction : direction;
    });
    return byIdThenField.map((r) => r.title);
  }

  it('lists the newest tasks first by default', async () => {
    const team = await createTeamWithProject(app);
    const rows = await seed(team);
    const page = await list(team.owner.api, team.tasksUrl);
    expect(titles(page.data)).toEqual(expectedOrder(rows, 'createdAt', 'desc'));
    expect(page.nextCursor).toBeNull();
  });

  // Every sort and order, with page sizes that put the page boundaries in
  // different places: inside a group of ties, and between the tasks with a
  // due date and those without one.
  it.each(['createdAt', 'updatedAt', 'dueDate'] as const)(
    'returns every task exactly once, in order, at any page size (sort=%s)',
    async (sort) => {
      const team = await createTeamWithProject(app);
      const rows = await seed(team);
      for (const order of ['asc', 'desc']) {
        for (const limit of [1, 2, 3, 4, 7, 10]) {
          const query = `sort=${sort}&order=${order}&limit=${String(limit)}`;
          const all = await walk(team.member.api, team.tasksUrl, query);
          expect(titles(all), query).toEqual(expectedOrder(rows, sort, order));
        }
      }
    },
  );

  it('pages through filtered results the same way', async () => {
    const team = await createTeamWithProject(app);
    const rows = await seed(team);
    await app.prisma.task.updateMany({
      where: { title: { in: ['t1', 't2', 't5', 't6', 't9'] } },
      data: { status: 'DONE' },
    });
    const done = rows.filter((r) => ['t1', 't2', 't5', 't6', 't9'].includes(r.title));

    const all = await walk(
      team.owner.api,
      team.tasksUrl,
      'status=DONE&sort=dueDate&order=asc&limit=2',
    );
    expect(titles(all)).toEqual(expectedOrder(done, 'dueDate', 'asc'));
  });

  it('moves an edited task to the front when sorting by updatedAt', async () => {
    const team = await createTeamWithProject(app);
    await seed(team);
    const oldest = await app.prisma.task.findFirstOrThrow({ where: { title: 't4' } });
    await team.owner.api.patch(`${team.tasksUrl}/${oldest.id}`, { status: 'DONE' });

    const page = await list(team.owner.api, `${team.tasksUrl}?sort=updatedAt&limit=1`);
    expect(titles(page.data)).toEqual(['t4']);
  });

  it('keeps working when the task a cursor points at is deleted', async () => {
    const team = await createTeamWithProject(app);
    const rows = await seed(team);
    const expected = expectedOrder(rows, 'dueDate', 'asc');

    const first = await list(team.owner.api, `${team.tasksUrl}?sort=dueDate&order=asc&limit=3`);
    const last = first.data.at(-1);
    await app.prisma.task.delete({ where: { id: last?.id ?? '' } });

    const next = await list(
      team.owner.api,
      `${team.tasksUrl}?sort=dueDate&order=asc&limit=3&cursor=${String(first.nextCursor)}`,
    );
    expect(titles(next.data)).toEqual(expected.slice(3, 6));
  });

  // A due-date page is read in two parts: the tasks with a due date, then
  // those without one. If each part saw the table at a different moment, a
  // task whose due date is set or cleared in between would be on the page
  // twice, or not at all.
  it('reads a due-date page from one snapshot, even while due dates change', async () => {
    const team = await createTeamWithProject(app);
    const rows = await seed(team);
    const everyId = sorted(rows.map((r) => r.id));
    const moving = rows.filter((r) => ['t1', 't4', 't6', 't10'].includes(r.title));

    for (let round = 0; round < 20; round++) {
      const dueDate = round % 2 === 0 ? null : '2026-12-15';
      await warmUpPool(app, 9);
      const [pages] = await Promise.all([
        Promise.all(
          Array.from({ length: 5 }, () =>
            list(team.member.api, `${team.tasksUrl}?sort=dueDate&limit=50`),
          ),
        ),
        Promise.all(
          moving.map((task) => team.owner.api.patch(`${team.tasksUrl}/${task.id}`, { dueDate })),
        ),
      ]);
      for (const page of pages) {
        expect(sorted(page.data.map((t) => t.id)), `round ${String(round)}`).toEqual(everyId);
      }
    }
  });

  it('returns 20 tasks per page by default', async () => {
    const team = await createTeamWithProject(app);
    await app.prisma.task.createMany({
      data: Array.from({ length: 21 }, (_, i) => ({
        workspaceId: team.workspaceId,
        projectId: team.project.id,
        title: `Task ${String(i)}`,
      })),
    });
    const page = await list(team.owner.api, team.tasksUrl);
    expect(page.data).toHaveLength(20);
    expect(page.nextCursor).toEqual(expect.any(String));
  });
});

describe('invalid cursors', () => {
  function forge(json: object) {
    return Buffer.from(JSON.stringify(json), 'utf8').toString('base64url');
  }
  const ID = '0b9d6c43-8c55-4c4e-9e0e-7f9a3e0f2a11';

  it('refuses a cursor made for another sort or order', async () => {
    const team = await createTeamWithProject(app);
    await createTask(team.owner.api, team.tasksUrl);
    await createTask(team.owner.api, team.tasksUrl);
    const { nextCursor } = await list(team.owner.api, `${team.tasksUrl}?limit=1`);

    for (const query of ['sort=updatedAt', 'order=asc', 'sort=dueDate&order=desc']) {
      const res = await team.owner.api.get(
        `${team.tasksUrl}?${query}&cursor=${String(nextCursor)}`,
      );
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_CURSOR');
    }
  });

  it('refuses a cursor from the task list of another project', async () => {
    const team = await createTeamWithProject(app);
    const other = await createProject(team.owner.api, team.workspaceId, 'Other');
    const otherTasksUrl = `${team.url}/projects/${other.id}/tasks`;
    await createTask(team.owner.api, otherTasksUrl);
    await createTask(team.owner.api, otherTasksUrl);
    const { nextCursor } = await list(team.owner.api, `${otherTasksUrl}?limit=1`);

    const res = await team.owner.api.get(`${team.tasksUrl}?cursor=${String(nextCursor)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_CURSOR');
  });

  it('refuses garbage', async () => {
    const team = await createTeamWithProject(app);
    const res = await team.owner.api.get(`${team.tasksUrl}?cursor=garbage`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_CURSOR');
  });

  // Each forged cursor is right for this list in every way but one: its value.
  it.each([
    ['a date instead of a timestamp', 'createdAt', '2026-11-19'],
    ['year 0', 'createdAt', '0000-01-01T00:00:00.000Z'],
    ['a timestamp instead of a date', 'dueDate', '2026-11-19T00:00:00.000Z'],
    ['a due date in year 0', 'dueDate', '0000-01-01'],
    ['null for a timestamp', 'updatedAt', null],
  ])('refuses a tampered cursor with %s, with 400 and not 500', async (_label, sort, value) => {
    const team = await createTeamWithProject(app);
    const scope = `tasks:${team.project.id}`;
    const cursor = forge({ scope, sort, order: 'desc', value, id: ID });
    const res = await team.owner.api.get(`${team.tasksUrl}?sort=${sort}&cursor=${cursor}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_CURSOR');
  });

  it('accepts a hand-made cursor that is valid: it is opaque, not secret', async () => {
    const team = await createTeamWithProject(app);
    await createTask(team.owner.api, team.tasksUrl, { title: 'Undated' });
    const scope = `tasks:${team.project.id}`;
    const cursor = forge({ scope, sort: 'dueDate', order: 'asc', value: '2026-01-01', id: ID });
    const page = await list(
      team.owner.api,
      `${team.tasksUrl}?sort=dueDate&order=asc&cursor=${cursor}`,
    );
    expect(titles(page.data)).toEqual(['Undated']);
  });
});
