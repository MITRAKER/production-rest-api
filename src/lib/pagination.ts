import { z } from 'zod';
import { LIMITS } from '../config/limits.js';
import { dateFromIso, IsoDay } from './dates.js';
import { Errors } from './errors.js';
import { invariant } from './invariant.js';
import { Text } from './text.js';

/**
 * Keyset ("cursor") pagination, shared by every paginated list.
 *
 * A list is sorted by one field plus the id as a tiebreaker, so the order is
 * total: no two rows are ever "equal". A cursor marks a position in that
 * order: the sort value and the id of the last item the client received. The
 * next page is "the rows after that position", which an index finds directly,
 * however far into the list the client is.
 *
 * The cursor carries the values themselves, not only an id. So it keeps
 * working even if that last item was edited or deleted in the meantime. It
 * also names the list it was made for (its scope, such as the tasks of one
 * project) and how that list was sorted, and it is refused anywhere else.
 *
 * It's base64url-encoded JSON: opaque to clients (they must not build or
 * change it), but not secret. Whatever comes back is validated like any other
 * input, because a client can send anything.
 */

export type SortOrder = 'asc' | 'desc';

/** The query parameters every paginated list accepts. */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(LIMITS.pageSizeDefault),
  cursor: Text.min(1).max(LIMITS.cursorMaxLength).optional(),
});

export type PageQuery = z.infer<typeof PageQuery>;

/** The shape of every paginated response: one page of items, and where the next one starts. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() });
}

const CursorSchema = z.object({
  /** The list the cursor belongs to, such as "tasks:<projectId>". */
  scope: z.string().max(60),
  sort: z.string().max(20),
  order: z.enum(['asc', 'desc']),
  /** The sort value of the last item, as an ISO date or date-time, or null. */
  value: z.string().max(40).nullable(),
  id: z.uuid(),
});

export type Cursor = z.infer<typeof CursorSchema>;

/** What a cursor must have been made for: the same list, sorted the same way. */
export type CursorKey = Pick<Cursor, 'scope' | 'sort' | 'order'>;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isMadeFor(cursor: Cursor, key: CursorKey): boolean {
  return cursor.scope === key.scope && cursor.sort === key.sort && cursor.order === key.order;
}

/**
 * Decodes a cursor and checks it was made for this list, sort and order.
 * Anything else (garbage, a tampered cursor, one from another list or from
 * this list sorted another way) is a 400 INVALID_CURSOR.
 */
export function decodeCursor(raw: string, key: CursorKey): Cursor {
  const json = parseJson(Buffer.from(raw, 'base64url').toString('utf8'));
  const parsed = CursorSchema.safeParse(json);
  if (!parsed.success || !isMadeFor(parsed.data, key)) throw Errors.invalidCursor();
  return parsed.data;
}

const IsoDateTime = z.iso.datetime();
/** No row was created before this, and Postgres rejects some older values (it has no year 0). */
const EARLIEST_TIMESTAMP = Date.UTC(1970, 0, 1);

/** A cursor value that must be a moment in time (sorting by createdAt or updatedAt). */
export function cursorDateTime(cursor: Cursor): Date {
  const parsed = IsoDateTime.safeParse(cursor.value);
  if (!parsed.success) throw Errors.invalidCursor();
  const date = new Date(parsed.data);
  if (Number.isNaN(date.getTime()) || date.getTime() < EARLIEST_TIMESTAMP) {
    throw Errors.invalidCursor();
  }
  return date;
}

/** A cursor value that must be a calendar date or null (sorting by a nullable date). */
export function cursorDate(cursor: Cursor): Date | null {
  if (cursor.value === null) return null;
  const parsed = IsoDay.safeParse(cursor.value);
  if (!parsed.success) throw Errors.invalidCursor();
  return dateFromIso(parsed.data);
}

/**
 * Turns the rows of a query that asked for `limit + 1` rows into one page.
 * The extra row only tells us that another page exists; it isn't returned.
 */
export function toPage<T>(rows: T[], limit: number, cursorOf: (last: T) => string) {
  invariant(rows.length <= limit + 1, `a page query returned ${String(rows.length)} rows`);
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  const hasMore = rows.length > limit && last !== undefined;
  return { data, nextCursor: hasMore ? cursorOf(last) : null };
}
