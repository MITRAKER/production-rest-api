import { Validator } from '@seriousme/openapi-schema-validator';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorResponse } from '../src/lib/errors.js';
import { buildTestApp } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

interface Operation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  security?: unknown[];
  responses: Record<
    string,
    {
      description: string;
      content?: Record<string, { schema: { $ref?: string }; example?: unknown }>;
    }
  >;
}

/** The OpenAPI document, as plain JSON: what a client downloads from /docs/json. */
function document() {
  return JSON.parse(JSON.stringify(app.swagger())) as {
    paths: Record<string, Record<string, Operation>>;
    tags: { name: string }[];
  };
}

/** Every operation in the document: one per route. */
function operations() {
  return Object.entries(document().paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({ path, method, operation })),
  );
}

describe('the OpenAPI document', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const result = await new Validator().validate(document());
    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  // The committed copy shows every change to the API in code review, like a
  // lockfile. After changing a route, run `npm run openapi` and commit it.
  it('matches openapi.json, the copy in the repository', async () => {
    await expect(`${JSON.stringify(app.swagger(), null, 2)}\n`).toMatchFileSnapshot(
      '../openapi.json',
    );
  });

  it('documents every route: name, summary, group, and every answer described', () => {
    const tags = document().tags.map((tag) => tag.name);
    const ids = operations().map(({ operation }) => operation.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { path, method, operation } of operations()) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(operation.operationId, where).toMatch(/^[a-z][A-Za-z]+$/);
      expect(operation.summary, where).toEqual(expect.any(String));
      expect(operation.tags, where).toHaveLength(1);
      expect(tags, where).toContain(operation.tags?.[0]);
      // `default` covers the errors any route can give (413, 415, 500...).
      expect(Object.keys(operation.responses), where).toContain('default');
      for (const response of Object.values(operation.responses)) {
        expect(response.description, where).not.toBe('Default Response');
      }
    }
  });

  it('shows a valid example under every error answer', () => {
    const errors = operations().flatMap(({ operation }) =>
      Object.values(operation.responses)
        .map((response) => response.content?.['application/json'])
        .filter((media) => media?.schema.$ref === '#/components/schemas/Error'),
    );
    expect(errors.length).toBeGreaterThan(50);
    for (const media of errors) expect(ErrorResponse.safeParse(media?.example).success).toBe(true);
  });

  it('is served at /docs/json, with a documentation page at /docs', async () => {
    const json = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(json.json()).toEqual(document());
    const page = await app.inject({ method: 'GET', url: '/docs' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    const assets = await app.inject({ method: 'GET', url: '/docs/static/swagger-initializer.js' });
    expect(assets.headers['content-security-policy']).toContain("script-src 'self'");
  });
});

describe('every route the document says needs a token', () => {
  it('answers 401 without one, before it even reads the body', async () => {
    const id = crypto.randomUUID();
    const isPublic = (operation: Operation) => operation.security?.length === 0;
    for (const { path, method, operation } of operations()) {
      const target = { method: method.toUpperCase(), url: path.replaceAll(/\{\w+\}/g, id) };
      // Broken JSON: a route that read the body before the token would answer 400.
      const broken = { headers: { 'content-type': 'application/json' }, payload: '{"broken' };
      const res = await app.inject(method === 'get' ? target : { ...target, ...broken });
      const code = res.json<{ error?: { code: string } }>().error?.code;
      const where = `${method.toUpperCase()} ${path}`;
      if (isPublic(operation)) expect(code, where).not.toBe('UNAUTHORIZED');
      else expect([res.statusCode, code], where).toEqual([401, 'UNAUTHORIZED']);
    }
  });
});
