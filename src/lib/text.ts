import { z } from 'zod';

/** The one character a Postgres text value can't hold. */
const NUL = '\u0000';

export const NUL_MESSAGE = 'Must not contain the NUL character (U+0000)';

/**
 * Every string a client sends: names, titles, descriptions, search terms,
 * passwords, tokens and cursors. Input schemas start from it instead of
 * z.string().
 *
 * Postgres text can hold any Unicode character except NUL. A statement that
 * carries one fails, and that failure would reach the client as a 500 for
 * what is really invalid input. So it's refused here, as a 400 like any other
 * invalid field. test/input-bounds.test.ts checks that every string input
 * does this.
 */
export const Text = z.string().refine((value) => !value.includes(NUL), NUL_MESSAGE);
