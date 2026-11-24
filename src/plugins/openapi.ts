import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { jsonSchemaTransform, jsonSchemaTransformObject } from 'fastify-type-provider-zod';
import { API_VERSION } from '../config/version.js';

const DESCRIPTION = `
A task manager's API: workspaces that people share with roles, projects in a
workspace, and tasks in a project.

**Logging in.** \`POST /auth/register\` or \`POST /auth/login\` answers with an
\`accessToken\` and a \`refreshToken\`. Send the access token on every other
request, as \`Authorization: Bearer <accessToken>\`. It's short-lived: when it
expires, trade the refresh token for new ones at \`POST /auth/refresh\`.

**Errors.** Every error has the same shape:
\`{ "error": { "code": "EMAIL_TAKEN", "message": "..." } }\`. Programs switch on
\`code\` (the \`Error\` schema lists them all); \`message\` is for people and its
wording may change. The only exceptions come from the HTTP server itself, for
requests that never reach the API: one it can't read (400), headers over
16 KB (431), a request that takes over 30 seconds to arrive (408), or one that
arrives during a shutdown (503). Those answers have no \`code\`.

**Request ids.** Every answer from the API has an \`x-request-id\` header.
Quote it when you report a problem: it finds that request's log lines.
`.trim();

/** The groups the documentation shows, in this order. */
const TAGS = [
  { name: 'health', description: 'Is the API up, and can it reach its database?' },
  { name: 'auth', description: 'Sign up, log in, and keep a session going' },
  { name: 'users', description: 'The logged-in user' },
  { name: 'workspaces', description: 'Shared spaces; each member has a role in each one' },
  { name: 'members', description: 'Who is in a workspace, with which role' },
  { name: 'invitations', description: 'How people join a workspace' },
  { name: 'projects', description: 'The projects of a workspace' },
  { name: 'tasks', description: 'The tasks of a project, with filters, sorting and pages' },
];

/** "#/components/schemas/Task" → "Task", for every reference in `value`. */
function referencedSchemas(value: unknown): string[] {
  const json = JSON.stringify(value ?? null);
  return Array.from(json.matchAll(/"#\/components\/schemas\/([^"]+)"/g), (match) => match[1] ?? '');
}

/**
 * fastify-type-provider-zod writes each named schema twice: "Task" as the API
 * sends it, and "TaskInput" as the API reads it (they differ when a schema
 * transforms what it reads). Our named schemas are only ever sent, so this
 * keeps the schemas the routes use, directly or through another schema.
 */
function usedSchemasOnly<S extends Record<string, unknown>>(schemas: S, paths: unknown): S {
  const used = new Set(referencedSchemas(paths));
  // Each round adds what the schemas found so far refer to. A round that adds
  // nothing ends the search, so there are never more rounds than schemas.
  const rounds = Object.keys(schemas).length;
  for (let round = 0; round < rounds; round += 1) {
    const before = used.size;
    for (const name of [...used]) referencedSchemas(schemas[name]).forEach((ref) => used.add(ref));
    if (used.size === before) break;
  }
  // The same schema objects, minus the unused ones: still an S.
  return Object.fromEntries(Object.entries(schemas).filter(([name]) => used.has(name))) as S;
}

/**
 * Zod writes an example given to a named schema (like the error answers in
 * src/lib/responses.ts) next to its `$ref`, where @fastify/swagger drops it.
 * This moves it to where OpenAPI keeps examples anyway: the answer's
 * `content`, beside the schema.
 */
function exampleBesideSchema(answer: unknown): unknown {
  if (typeof answer !== 'object' || answer === null || !('$ref' in answer)) return answer;
  if (!('examples' in answer) || !Array.isArray(answer.examples)) return answer;
  const description = 'description' in answer ? answer.description : undefined;
  const examples: unknown[] = answer.examples;
  const media = { schema: { $ref: answer.$ref }, example: examples[0] };
  return { description, content: { 'application/json': media } };
}

/** Documents one route: Zod schemas to JSON Schema, then examples where they belong. */
const transform: typeof jsonSchemaTransform = (route) => {
  const result = jsonSchemaTransform(route);
  // A copy: it also copes with a route that has no schema at all (undefined).
  const schema = { ...result.schema };
  const answers: unknown = schema.response;
  if (typeof answers !== 'object' || answers === null) return result;
  const response = Object.fromEntries(
    Object.entries(answers).map(([status, answer]) => [status, exampleBesideSchema(answer)]),
  );
  return { ...result, schema: { ...schema, response } };
};

/**
 * The OpenAPI document, generated from the same Zod schemas that check every
 * request and response. The documentation can't drift from what the API
 * does: it's built from the same code.
 *
 * - GET /docs       an interactive page (Swagger UI) to read and try the API
 * - GET /docs/json  the document itself, for client generators and Postman
 * - GET /docs/yaml  the same, in YAML
 *
 * Register it before the routes: it collects each route as it's added.
 */
export default fp(
  async (app) => {
    await app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title: 'Production REST API',
          version: API_VERSION,
          description: DESCRIPTION,
          license: { name: 'MIT', identifier: 'MIT' },
        },
        tags: TAGS,
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
              description: 'The accessToken from POST /auth/login or POST /auth/register',
            },
          },
        },
        // Every route needs a token, unless its schema says `security: []`.
        security: [{ bearerAuth: [] }],
      },
      transform,
      transformObject: (input) => {
        // A new object each time, so changing it changes nothing else.
        const document = jsonSchemaTransformObject(input);
        if ('components' in document && document.components.schemas !== undefined) {
          document.components.schemas = usedSchemasOnly(
            document.components.schemas,
            document.paths,
          );
        }
        return document;
      },
    });

    // staticCSP: the page gets a Content-Security-Policy, so it only runs this server's scripts.
    await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });
  },
  { name: 'openapi' },
);
