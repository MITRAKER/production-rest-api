import { z } from 'zod';

/** The one character a Postgres text value can't hold. */
const NUL = '\u0000';

export const NUL_MESSAGE = 'Must not contain the NUL character (U+0000)';
export const UNICODE_MESSAGE = 'Must be valid Unicode (no unpaired surrogate)';

/**
 * Every string a client sends that we store or search with: names, titles,
 * descriptions, search terms, tokens and cursors. Input schemas start from it
 * instead of z.string(). It refuses two strings that JSON allows but the
 * database can't keep as they are:
 *
 * - NUL: Postgres text can hold any Unicode character except NUL. A statement
 *   that carries one fails, and that failure would reach the client as a 500
 *   for what is really invalid input.
 * - Half a character: JavaScript strings are UTF-16, where some characters
 *   (emoji, for example) take two code units, a "surrogate pair". JSON can
 *   send one half alone ("\uD800"), which is no character at all. The
 *   database driver quietly replaces it with U+FFFD (�), so we would store,
 *   and answer with, a different string than the one we were sent.
 *
 * Both become a 400, like any other invalid field. test/input-bounds.test.ts
 * checks that every free-text input refuses them.
 */
export const Text = z
  .string()
  .refine((value) => !value.includes(NUL), NUL_MESSAGE)
  .refine((value) => value.isWellFormed(), UNICODE_MESSAGE);
