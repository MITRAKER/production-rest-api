import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NUL_MESSAGE } from '../src/lib/text.js';
import * as authSchemas from '../src/modules/auth/auth.schemas.js';
import * as invitationSchemas from '../src/modules/invitations/invitations.schemas.js';
import * as projectSchemas from '../src/modules/projects/projects.schemas.js';
import * as taskSchemas from '../src/modules/tasks/tasks.schemas.js';
import * as workspaceSchemas from '../src/modules/workspaces/workspaces.schemas.js';

/**
 * Rules that every input schema (exports named *Body, *Params or *Query) must
 * follow, checked automatically on all of them:
 *
 * - Power of Ten rule 3: every value a client can send has an upper bound.
 *   Each schema is converted to JSON Schema, and every string must have a
 *   maxLength (or a fixed format) and every array a maxItems.
 * - No string may contain the NUL character, which Postgres text can't hold
 *   (see src/lib/text.ts).
 *
 * When you add a schema module, add it to `modules` below.
 */
const modules: Record<string, Record<string, unknown>> = {
  auth: authSchemas,
  workspaces: workspaceSchemas,
  invitations: invitationSchemas,
  projects: projectSchemas,
  tasks: taskSchemas,
};

type JsonNode = Record<string, unknown>;

/** Strings of these formats have a fixed, short length ("date" is YYYY-MM-DD). */
const FIXED_LENGTH_FORMATS = new Set(['uuid', 'date']);
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

function toJson(schema: z.ZodType): JsonNode {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
}

describe('every client input is bounded (Power of Ten rule 3)', () => {
  it('finds the input schemas', () => {
    expect(inputSchemas.length).toBeGreaterThan(0);
  });

  for (const { name, schema } of inputSchemas) {
    it(name, () => {
      expect(unboundedParts(toJson(schema))).toEqual([]);
    });
  }
});

/** The top-level fields that take free text: strings that aren't an id, a date, an email or a fixed value. */
function freeTextFields(json: JsonNode): string[] {
  const properties = isObject(json['properties']) ? json['properties'] : {};
  return Object.entries(properties)
    .filter(([, node]) => isObject(node) && node['type'] === 'string')
    .filter(([, node]) => !['format', 'enum', 'const'].some((key) => key in (node as JsonNode)))
    .map(([field]) => field);
}

const textFields = inputSchemas.flatMap(({ name, schema }) =>
  freeTextFields(toJson(schema)).map((field) => ({ name: `${name}.${field}`, schema, field })),
);

describe('no client string may contain NUL (U+0000)', () => {
  it('finds the free-text fields', () => {
    const names = textFields.map((f) => f.name);
    expect(names).toContain('auth.RegisterBody.password');
    expect(names).toContain('projects.CreateProjectBody.description');
    expect(names).toContain('tasks.TaskListQuery.q');
    expect(names).toContain('tasks.TaskListQuery.cursor');
  });

  for (const { name, schema, field } of textFields) {
    it(name, () => {
      const result = schema.safeParse({ [field]: 'some text\u0000' });
      const issues = result.error?.issues ?? [];
      const messages = issues.filter((issue) => issue.path[0] === field).map((i) => i.message);
      expect(messages).toContain(NUL_MESSAGE);
    });
  }
});
