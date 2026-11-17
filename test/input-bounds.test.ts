import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as authSchemas from '../src/modules/auth/auth.schemas.js';

/**
 * Power of Ten rule 3, checked automatically: every value a client can send
 * must have an upper bound. This test converts every input schema (exports
 * named *Body, *Params or *Query) to JSON Schema and checks that every string
 * has a maxLength (or a fixed format) and every array has a maxItems.
 *
 * When you add a schema module, add it to `modules` below.
 */
const modules: Record<string, Record<string, unknown>> = { auth: authSchemas };

type JsonNode = Record<string, unknown>;

/** Strings of these formats have a fixed, short length. */
const FIXED_LENGTH_FORMATS = new Set(['uuid']);
const MAX_NODES = 10_000;

function isObject(value: unknown): value is JsonNode {
  return typeof value === 'object' && value !== null;
}

function isBoundedString(node: JsonNode): boolean {
  const format = node['format'];
  return (
    typeof node['maxLength'] === 'number' ||
    Array.isArray(node['enum']) ||
    'const' in node ||
    (typeof format === 'string' && FIXED_LENGTH_FORMATS.has(format))
  );
}

/** The problem with this one schema node, if any (its children are checked separately). */
function problemAt(node: JsonNode, path: string): string | null {
  const where = path === '' ? '/' : path;
  if (node['type'] === 'string' && !isBoundedString(node))
    return `${where}: string without maxLength`;
  if (node['type'] === 'array' && typeof node['maxItems'] !== 'number') {
    return `${where}: array without maxItems`;
  }
  return null;
}

/**
 * Every problem in a JSON Schema. Walks it with an explicit stack and a hard
 * iteration limit instead of recursion (Power of Ten rules 1 and 2).
 */
function unboundedParts(root: JsonNode): string[] {
  const problems: string[] = [];
  const stack = [{ node: root, path: '' }];
  for (let i = 0; i < MAX_NODES; i++) {
    const current = stack.pop();
    if (current === undefined) return problems;
    const problem = problemAt(current.node, current.path);
    if (problem !== null) problems.push(problem);
    for (const [key, child] of Object.entries(current.node)) {
      if (isObject(child)) stack.push({ node: child, path: `${current.path}/${key}` });
    }
  }
  throw new Error(`schema has more than ${String(MAX_NODES)} nodes`);
}

const inputSchemas = Object.entries(modules).flatMap(([moduleName, exports]) =>
  Object.entries(exports)
    .filter(([name, value]) => /(Body|Params|Query)$/.test(name) && value instanceof z.ZodType)
    .map(([name, value]) => ({ name: `${moduleName}.${name}`, schema: value as z.ZodType })),
);

describe('every client input is bounded (Power of Ten rule 3)', () => {
  it('finds the input schemas', () => {
    expect(inputSchemas.length).toBeGreaterThan(0);
  });

  for (const { name, schema } of inputSchemas) {
    it(name, () => {
      const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
      expect(unboundedParts(json as JsonNode)).toEqual([]);
    });
  }
});
