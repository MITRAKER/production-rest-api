import { z } from 'zod';

/**
 * An id a client sends, in a URL, a body or a query string: a UUID, turned
 * into lower case.
 *
 * Validating the format turns a malformed id into a clean 400, instead of a
 * database error (500). It checks only the shape Postgres reads: 8-4-4-4-12
 * hex digits, in either case (z.guid()). z.uuid() checks more, the version
 * and variant digits, and makes an exception for the nil and the max uuid,
 * but for the max one only in lower case: "FFFFFFFF-…" got a 400, while
 * "ffffffff-…" was looked up and got a 404. One id, two answers.
 *
 * Lower-casing it matters too. Postgres compares uuids by value, so "7C1E…"
 * and "7c1e…" find the same row. But our code also compares ids as text: "is
 * the member being removed the caller?", "was this cursor made for this
 * list?". Ids from the database are always lower case, and some clients write
 * UUIDs in upper case (Swift's uuidString does). One id spelled two ways would
 * look like two different ids, so every id that comes in gets the database's
 * spelling.
 */
export const Id = z.guid('Invalid UUID').transform((id) => id.toLowerCase());
