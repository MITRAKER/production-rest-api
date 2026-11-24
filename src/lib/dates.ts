import { z } from 'zod';

/**
 * Calendar dates, like a task's due date: a day, not a moment in time. They
 * have no hours and no time zone, so the API sends and receives them as
 * "2026-12-31", never as a full timestamp (which a client in another time
 * zone could read as the 30th or the 1st).
 *
 * Postgres stores them in a DATE column. Prisma represents a DATE as a JS Date
 * at midnight UTC on that day; the two helpers below convert both ways.
 */

/** The earliest date the API accepts. */
const MIN_DAY = '1900-01-01';

/**
 * A calendar date as "YYYY-MM-DD", from 1900-01-01 to 9999-12-31. Zod checks
 * that the day exists (no February 30th). The lower bound keeps out dates
 * Postgres rejects, such as year 0, so a typo answers 400 instead of failing
 * in the database with a 500. Fixed-width dates compare correctly as strings.
 */
export const IsoDay = z.iso
  .date()
  .refine((day) => day >= MIN_DAY, { message: `Must be ${MIN_DAY} or later` });

/** "2026-12-31" → midnight UTC on that day, the form Prisma uses for DATE columns. */
export function dateFromIso(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** The inverse of dateFromIso: a DATE column's value back to "2026-12-31". */
export function isoFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
