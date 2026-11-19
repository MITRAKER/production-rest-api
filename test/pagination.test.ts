import { describe, expect, it } from 'vitest';
import { dateFromIso, IsoDay, isoFromDate } from '../src/lib/dates.js';
import { AppError } from '../src/lib/errors.js';
import { InvariantError } from '../src/lib/invariant.js';
import {
  cursorDate,
  cursorDateTime,
  decodeCursor,
  encodeCursor,
  toPage,
  type Cursor,
} from '../src/lib/pagination.js';
import { escapeLike, taskFilters } from '../src/modules/tasks/tasks.query.js';
import { TaskListQuery } from '../src/modules/tasks/tasks.schemas.js';

/**
 * Unit tests for the pure parts of pagination, dates and task list queries:
 * no database, no HTTP. The API tests (task-lists.test.ts) check that the
 * pieces work together.
 */

const ID = '0b9d6c43-8c55-4c4e-9e0e-7f9a3e0f2a11';

function cursor(overrides: Partial<Cursor> = {}): Cursor {
  return {
    sort: 'createdAt',
    order: 'asc',
    value: '2026-11-19T16:31:05.123Z',
    id: ID,
    ...overrides,
  };
}

/** Base64url-encodes any JSON, the way a client tampering with a cursor would. */
function rawCursor(json: unknown): string {
  return Buffer.from(JSON.stringify(json), 'utf8').toString('base64url');
}

/** The error code that fn throws, so each test can check it's a clean 400 and not a crash. */
function errorCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof AppError ? err.code : `not an AppError: ${String(err)}`;
  }
  return 'no error';
}

describe('cursors', () => {
  it('decodes what it encoded', () => {
    const original = cursor();
    expect(decodeCursor(encodeCursor(original), 'createdAt', 'asc')).toEqual(original);
    expect(
      decodeCursor(encodeCursor(cursor({ value: null })), 'createdAt', 'asc').value,
    ).toBeNull();
  });

  it('only accepts a cursor made for the same sort and order', () => {
    const raw = encodeCursor(cursor());
    expect(errorCode(() => decodeCursor(raw, 'updatedAt', 'asc'))).toBe('INVALID_CURSOR');
    expect(errorCode(() => decodeCursor(raw, 'createdAt', 'desc'))).toBe('INVALID_CURSOR');
  });

  it.each([
    ['not base64 JSON', '!!!'],
    ['an empty string', ''],
    ['JSON null', rawCursor(null)],
    ['an array', rawCursor([])],
    ['missing fields', rawCursor({ sort: 'createdAt', order: 'asc' })],
    ['an id that is not a uuid', rawCursor({ ...cursor(), id: '42' })],
    ['an unknown order', rawCursor({ ...cursor(), order: 'sideways' })],
    ['a value that is too long', rawCursor({ ...cursor(), value: 'x'.repeat(41) })],
    ['a value of the wrong type', rawCursor({ ...cursor(), value: 1 })],
  ])('rejects %s', (_label, raw) => {
    expect(errorCode(() => decodeCursor(raw, 'createdAt', 'asc'))).toBe('INVALID_CURSOR');
  });
});

describe('cursor values', () => {
  it('reads a timestamp', () => {
    expect(cursorDateTime(cursor()).toISOString()).toBe('2026-11-19T16:31:05.123Z');
  });

  it.each([
    ['null', null],
    ['a calendar date', '2026-11-19'],
    ['a month that does not exist', '2026-13-01T00:00:00.000Z'],
    ['a time zone offset', '2026-11-19T16:31:05+02:00'],
    ['year 0, which Postgres rejects', '0000-01-01T00:00:00.000Z'],
    ['a moment before 1970', '1969-12-31T23:59:59.999Z'],
  ])('rejects %s as a timestamp', (_label, value) => {
    expect(errorCode(() => cursorDateTime(cursor({ value })))).toBe('INVALID_CURSOR');
  });

  it('reads a calendar date, or null (a task without a due date)', () => {
    expect(cursorDate(cursor({ value: '2026-12-31' }))?.toISOString()).toBe(
      '2026-12-31T00:00:00.000Z',
    );
    expect(cursorDate(cursor({ value: null }))).toBeNull();
  });

  it.each([
    ['a timestamp', '2026-12-31T00:00:00.000Z'],
    ['a day that does not exist', '2026-02-30'],
    ['year 0', '0000-01-01'],
  ])('rejects %s as a calendar date', (_label, value) => {
    expect(errorCode(() => cursorDate(cursor({ value })))).toBe('INVALID_CURSOR');
  });
});

describe('toPage', () => {
  const cursorOf = (n: number) => `after-${String(n)}`;

  it('has no next page when the query returned at most `limit` rows', () => {
    expect(toPage([1, 2], 3, cursorOf)).toEqual({ data: [1, 2], nextCursor: null });
    expect(toPage([1, 2, 3], 3, cursorOf)).toEqual({ data: [1, 2, 3], nextCursor: null });
    expect(toPage([], 3, cursorOf)).toEqual({ data: [], nextCursor: null });
  });

  it('drops the extra row, and points the cursor at the last row it returns', () => {
    expect(toPage([1, 2, 3, 4], 3, cursorOf)).toEqual({ data: [1, 2, 3], nextCursor: 'after-3' });
  });

  it('treats more than limit + 1 rows as a bug', () => {
    expect(() => toPage([1, 2, 3, 4, 5], 3, cursorOf)).toThrow(InvariantError);
  });
});

describe('calendar dates', () => {
  it('converts both ways without shifting the day', () => {
    expect(isoFromDate(dateFromIso('2026-12-31'))).toBe('2026-12-31');
    expect(dateFromIso('2028-02-29').toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });

  it.each(['1900-01-01', '2028-02-29', '9999-12-31'])('accepts %s', (day) => {
    expect(IsoDay.safeParse(day).success).toBe(true);
  });

  it.each(['1899-12-31', '2026-02-29', '2026-13-01', '31/12/2026', '2026-12-31T00:00:00Z', ''])(
    'rejects %s',
    (day) => {
      expect(IsoDay.safeParse(day).success).toBe(false);
    },
  );
});

describe('task list query', () => {
  const parse = (query: Record<string, string>) => TaskListQuery.safeParse(query);

  it('has defaults: newest first, 20 per page', () => {
    expect(parse({}).data).toEqual({ limit: 20, sort: 'createdAt', order: 'desc' });
  });

  it('splits comma-separated lists and checks every item', () => {
    expect(parse({ status: 'TODO,DONE' }).data?.status).toEqual(['TODO', 'DONE']);
    expect(parse({ status: 'TODO,NOPE' }).success).toBe(false);
    expect(parse({ status: '' }).success).toBe(false);
    expect(parse({ priority: 'LOW,MEDIUM,HIGH,LOW' }).success).toBe(false);
  });

  it('accepts a member id or "none" as assignee', () => {
    expect(parse({ assigneeId: ID }).success).toBe(true);
    expect(parse({ assigneeId: 'none' }).success).toBe(true);
    expect(parse({ assigneeId: 'me' }).success).toBe(false);
  });

  it('only sorts by allowed fields, and needs dueFrom on or before dueTo', () => {
    expect(parse({ sort: 'title' }).success).toBe(false);
    expect(parse({ order: 'up' }).success).toBe(false);
    expect(parse({ dueFrom: '2026-12-31', dueTo: '2026-12-31' }).success).toBe(true);
    expect(parse({ dueFrom: '2026-12-31', dueTo: '2026-12-30' }).success).toBe(false);
  });

  it('turns the filters into Prisma conditions', () => {
    const query = TaskListQuery.parse({
      status: 'TODO',
      priority: 'HIGH',
      assigneeId: 'none',
      dueFrom: '2026-12-01',
      dueTo: '2026-12-31',
      q: '  100%  ',
    });
    expect(taskFilters(query)).toEqual([
      { status: { in: ['TODO'] } },
      { priority: { in: ['HIGH'] } },
      { assigneeId: null },
      { dueDate: { gte: new Date('2026-12-01T00:00:00.000Z') } },
      { dueDate: { lte: new Date('2026-12-31T00:00:00.000Z') } },
      { title: { contains: '100\\%', mode: 'insensitive' } },
    ]);
    expect(taskFilters(TaskListQuery.parse({}))).toEqual([]);
  });
});

describe('escapeLike', () => {
  it('escapes the LIKE wildcards and the escape character itself', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('back\\slash')).toBe('back\\\\slash');
    expect(escapeLike('plain text')).toBe('plain text');
  });
});
