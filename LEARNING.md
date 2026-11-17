# Learning Guide: Building a Production REST API

This file grows with the project. Each chapter explains one step: **what** was built,
**why** it was designed that way, the **concepts** behind it, and **exercises** so you
can rebuild it yourself without looking.

| Chapter | Step | Status |
| ------- | ---- | ------ |
| 1 | Project skeleton, Postgres, health checks, tests, Docker, CI | ✅ |
| 2 | Authentication: register, login, refresh tokens, logout | ⏳ |
| 3 | Workspaces, members and role-based permissions | ⏳ |
| 4 | Projects and tasks: pagination, filtering, sorting | ⏳ |
| 5 | Error format, logging, OpenAPI docs | ⏳ |
| 6 | Test coverage, seed data, recruiter-ready README | ⏳ |

---

## Chapter 1: The skeleton

### What we built

A tiny API that does almost nothing yet, but is wired the way real production services are:

```
GET /health/live   -> 200 {"status":"ok"}
GET /health/ready  -> 200 {"status":"ok","database":"up"}   (or 503 if the DB is down)
```

Plus everything around it: typed config, a database connection, structured logs,
automated tests, a Docker image and a CI pipeline that runs on every pull request.

It may feel strange to spend a whole step on an app with two endpoints. That's the point:
in a real job, the skeleton is where most "production" quality comes from. Every later
feature inherits it for free.

### The folder layout

```
src/
  config/env.ts        # reads and validates settings
  plugins/prisma.ts    # database connection, shared with the whole app
  routes/health.ts     # the two health endpoints
  app.ts               # buildApp(): assembles plugins and routes
  server.ts            # starts listening, handles shutdown
  generated/prisma/    # code Prisma writes for us (not committed)
prisma/schema.prisma   # database tables (none yet)
test/health.test.ts    # automated tests
Dockerfile, docker-compose.yml, .github/workflows/ci.yml
```

**Why split it like this?** Each file has one job. When something breaks you know where to
look, and when you add a feature you add files instead of growing one giant file.

### Concept 1: Why Fastify (and not Express)?

Express is the classic choice, and you'll see it everywhere. Fastify does the same job but:

- **Schemas built in.** You describe a route's input and output, and Fastify validates
  requests and serializes responses from that description. Faster and safer.
- **Plugins with scope.** Features are packaged as plugins with clear boundaries
  (see Concept 4).
- **Async-first.** Route handlers just `return` a value or `throw` an error.
- **Built-in structured logging** with pino.

Knowing both is good. Fastify shows you understand the "why" behind modern backends.

### Concept 2: Validate configuration at startup ("fail fast")

`src/config/env.ts` uses **Zod** to describe every environment variable the app needs:

```ts
const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  ...
});
```

If `DATABASE_URL` is missing, the app refuses to start and prints exactly what's wrong.
Without this, the app would start "fine" and crash on the first request that touches the
database, maybe hours later, maybe only in production.

Bonus: `z.infer<typeof EnvSchema>` gives us a TypeScript type for free, so
`env.PORT` is known to be a `number` everywhere.

> **Rule of thumb:** anything coming from outside your code (env vars, HTTP requests,
> files) is untrusted until validated.

### Concept 3: Prisma and connection pools

**Prisma** is an ORM: you describe tables in `prisma/schema.prisma`, and it generates a
fully typed client (`prisma.user.findMany(...)`) so the TypeScript compiler catches typos
in column names.

Opening a database connection is slow (network handshake, authentication). So we create
**one** `PrismaClient` for the whole app; under the hood it keeps a **pool** of open
connections and reuses them across requests. Creating a client per request is a classic
beginner bug that exhausts the database's connection limit under load.

Prisma 7 talks to Postgres through a **driver adapter** (`@prisma/adapter-pg`, built on the
standard `pg` driver), which is why you see `new PrismaClient({ adapter })`.

### Concept 4: Fastify plugins and decorators

`src/plugins/prisma.ts` is a plugin. It:

1. creates the client,
2. `app.decorate('prisma', prisma)` attaches it so any route can use `app.prisma`,
3. `app.addHook('onClose', ...)` disconnects when the app shuts down.

By default Fastify plugins are **encapsulated**: what they add is only visible inside them.
Wrapping with `fastify-plugin` (`fp`) "breaks" encapsulation on purpose so the whole app
sees `app.prisma`. The `declare module 'fastify'` block tells TypeScript that the property
exists.

### Concept 5: Liveness vs readiness

Two different questions:

- **Liveness** (`/health/live`): "Is the process alive?" If this fails, restart it.
  It must never check the DB, otherwise a database blip would restart every API instance.
- **Readiness** (`/health/ready`): "Can it serve traffic right now?" It runs `SELECT 1`.
  If this fails, the load balancer stops sending traffic here until it recovers, and
  returns **503 Service Unavailable**.

Kubernetes, AWS ECS and Docker all use this pattern.

### Concept 6: Structured logs and request IDs

Fastify logs JSON lines, not free text:

```json
{"level":30,"reqId":"6566…","req":{"method":"GET","url":"/health/ready"},"msg":"incoming request"}
```

Machines (Grafana Loki, Datadog, CloudWatch) can search and filter JSON. Every request gets
a UUID (`genReqId`), and we send it back in an `x-request-id` header. When a user reports a
bug, they give you that id, and you find every log line for that exact request.

In development we pipe logs through `pino-pretty` so they're readable for humans.

### Concept 7: Separate "build" from "listen" (testability)

`app.ts` exports `buildApp()`, which assembles the app but **doesn't** open a port.
`server.ts` is the only file that calls `listen()`.

This lets tests do:

```ts
const app = await buildApp(loadEnv());
const res = await app.inject({ method: 'GET', url: '/health/live' });
expect(res.statusCode).toBe(200);
```

`app.inject()` simulates an HTTP request in memory: no port, no network, very fast, and
it goes through the exact same routing, validation and hooks as a real request.

### Concept 8: A real database in tests

Tests run against a **real Postgres** (`api_test`), not a mock. Mocks can lie: a query
that works against a mock can fail on real Postgres. A separate test database means
tests can freely create and delete data without touching your dev data.
`vitest.config.ts` loads `.env.test` to point tests at it.

### Concept 9: Graceful shutdown

When you deploy a new version, the platform sends the old process `SIGTERM`. We catch it
and call `app.close()`, which stops accepting new connections, lets in-flight requests
finish, runs `onClose` hooks (closing the DB pool), and then exits. Without this, users
get random errors during every deploy.

### Concept 10: Multi-stage Docker builds

The `Dockerfile` has two stages:

1. **build**: installs everything (TypeScript, Prisma CLI), compiles to `dist/`.
2. **runtime**: copies only `dist/` and production dependencies.

The final image is smaller (faster deploys) and has fewer tools an attacker could use.
It also runs as the unprivileged `node` user, never as root.

### Concept 11: Continuous Integration

`.github/workflows/ci.yml` runs on every push and pull request:

1. starts a throwaway Postgres as a **service container**,
2. `npm ci` (clean, reproducible install from `package-lock.json`),
3. type-check, test, build,
4. builds the Docker image to prove it still builds.

A green check on every PR is one of the first things a reviewer (or recruiter browsing
your GitHub) looks at.

### Build it yourself

Try recreating this chapter from an empty folder, peeking only when stuck:

1. `npm init -y`, set `"type": "module"`, install `fastify zod` and dev deps `typescript tsx vitest @types/node`.
2. Write `env.ts` with a Zod schema for `PORT` only. Make the app crash with a nice message when `PORT=abc`.
3. Write `buildApp()` with a single `GET /health/live` route, and `server.ts` that listens.
4. Write one Vitest test using `app.inject()`.
5. Add Prisma: `npm i @prisma/client @prisma/adapter-pg pg`, `npm i -D prisma`, create `schema.prisma`, run `npx prisma generate`.
6. Add the Prisma plugin and the `/health/ready` route.
7. Add the `x-request-id` header and a test for it.
8. Write the Dockerfile and the CI workflow.

### Exercises

1. **Break it on purpose.** Stop Postgres and call `/health/ready`. What status and log
   line do you get? Does `/health/live` still return 200? Why does that matter?
2. **Add a version endpoint.** `GET /version` returning `{ "version": "1.0.0" }` read
   from `package.json`, with a response schema and a test.
3. **Config challenge.** Add a `CORS_ORIGIN` env var that must be a URL in production but
   is optional in development. (Hint: Zod's `.superRefine` or `.refine`.)
4. **Think about it.** Why does the readiness check use `SELECT 1` instead of querying a
   real table?

### Words to know

REST · endpoint · status code (200, 404, 503) · environment variable · ORM ·
connection pool · plugin · decorator · liveness/readiness probe · structured logging ·
request id · integration test · graceful shutdown · SIGTERM · multi-stage build · CI
