# Learning Guide: Building a Production REST API

This file grows with the project. Each chapter explains one step: **what** was built,
**why** it was designed that way, the **concepts** behind it, and **exercises** so you
can rebuild it yourself without looking.

| Chapter | Step | Status |
| ------- | ---- | ------ |
| 1 | Project skeleton, Postgres, health checks, tests, Docker, CI | ✅ |
| 2 | Authentication: register, login, refresh tokens, logout | ✅ |
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

---

## Chapter 2: Authentication

### What we built

```
POST /auth/register  {email, password, name}  -> 201 {user, accessToken, refreshToken}
POST /auth/login     {email, password}        -> 200 {user, accessToken, refreshToken}
POST /auth/refresh   {refreshToken}           -> 200 {accessToken, refreshToken}   (new pair)
POST /auth/logout    {refreshToken}           -> 204
GET  /users/me       Authorization: Bearer …  -> 200 {id, email, name, createdAt}
```

Plus: a `users` and `refresh_tokens` table (our first migration), one consistent error
format, input validation with Zod, rate limiting on login, and 18 new tests.

### New files

```
prisma/migrations/…_auth/migration.sql  # the SQL Prisma generated for our tables
src/lib/errors.ts                       # AppError: status + stable code + message
src/plugins/error-handler.ts            # turns every error into the same JSON shape
src/plugins/auth.ts                     # JWT setup + app.authenticate guard
src/modules/auth/auth.schemas.ts        # Zod schemas for requests and responses
src/modules/auth/auth.service.ts        # the business logic (hashing, tokens, rotation)
src/modules/auth/auth.routes.ts         # thin HTTP layer that calls the service
src/modules/users/users.routes.ts       # GET /users/me
test/global-setup.ts, test/helpers.ts   # migrate test DB, reset tables, shared helpers
test/auth.test.ts                       # 18 tests
```

**Why "modules"?** As the API grows, grouping by feature (`auth/`, `users/`, later
`workspaces/`, `tasks/`) scales better than grouping by type (`all-routes/`,
`all-services/`). Everything about auth lives in one folder.

**Why routes + service?** Routes deal with HTTP (status codes, headers). The service deals
with rules (how to hash, when a token is valid). Keeping them apart means you could call
`AuthService` from a CLI script or a background job without faking HTTP.

### Concept 1: Migrations

You never edit a production database by hand. Instead:

1. change `prisma/schema.prisma` (we added `User` and `RefreshToken`),
2. run `npm run db:migrate -- --name auth`,
3. Prisma compares the schema with the DB and writes a SQL file in `prisma/migrations/`.

That SQL file is committed. Every environment (your laptop, CI, production) runs the
same files in the same order (`prisma migrate deploy`), so they all end up identical.
Open `migration.sql` and read it: it's plain SQL, and you should always review it.

Notice `@map("password_hash")` and `@@map("users")`: TypeScript uses `camelCase`, SQL
conventionally uses `snake_case` table and column names. Mapping gives you both.

### Concept 2: Never store passwords, store slow hashes

A hash is a one-way function: easy to compute from the password, practically impossible
to reverse. At login we hash what the user typed and compare.

But regular hashes (SHA-256) are *fast*, and a GPU can try billions per second against a
leaked database. **argon2id** is designed to be slow and use lots of memory, which kills
that attack. It also adds a random **salt** per user, so two people with the same password
get different hashes. The salt is stored inside the hash string (`$argon2id$v=19$m=…`).

Also notice the password has a **max** length (128). Without it, someone could send a 10 MB
password and make the server spend seconds hashing it.

### Concept 3: Don't leak which emails exist

Login returns the exact same `401 INVALID_CREDENTIALS` for "no such email" and "wrong
password". If the messages differed, attackers could build a list of real accounts.

Subtler: if unknown emails returned instantly but real ones took 100 ms (argon2 is slow),
the *timing* would leak the same thing. So for unknown emails we still run
`argon2.verify` against a dummy hash. Look for `getDummyHash` in `auth.service.ts`.

### Concept 4: Access tokens (JWT)

After login the client gets an **access token**, a JWT, and sends it on every request:
`Authorization: Bearer eyJhbGci…`.

A JWT is three base64 parts: `header.payload.signature`. The payload is just
`{"sub":"<user id>","iat":…,"exp":…}`. **It is readable by anyone** (paste one into
jwt.io), so never put secrets in it. What makes it trustworthy is the **signature**:
an HMAC of header + payload using `JWT_ACCESS_SECRET`. Change one character of the payload
and the signature no longer matches (the "rejects a tampered token" test proves it).

Why JWTs? The server can verify them with no database lookup, which is fast and scales.
The downside: you can't "cancel" one before it expires. So we keep them **short-lived
(15 minutes)**.

We also pin the algorithm (`algorithms: ['HS256']`). Some old JWT libraries trusted the
`alg` field in the token itself, letting attackers pick `none`. Pinning prevents that.

### Concept 5: Refresh tokens and rotation

15-minute logins would be annoying, so login also returns a **refresh token**: a long
random string (32 bytes) valid for 30 days, used only to get new access tokens.

- It's **random, not a JWT**, and stored in the DB, so we *can* revoke it.
- We store only its **SHA-256 hash**. If the database leaks, the tokens can't be used.
  (Fast SHA-256 is fine here, unlike passwords: the token is 256 random bits, there's
  nothing to guess.)
- **Rotation:** each `/auth/refresh` revokes the old refresh token and issues a new one.
- **Reuse detection:** all tokens from one login share a `familyId`. If a *revoked* token
  is presented again, either the user or a thief is using a stale copy. We can't tell
  which, so we revoke the whole family and both must log in again. This is the approach
  recommended by the OAuth 2.0 security best practices.
- **Race safety:** we revoke with `updateMany({ where: { id, revokedAt: null } })` and check
  that it changed 1 row. If two requests refresh the same token at the same instant, only
  one wins.

> **Where should clients keep tokens?** For browser apps, an `HttpOnly`, `Secure`,
> `SameSite` cookie is safest for the refresh token because JavaScript can't read it.
> We return tokens in JSON because it keeps this API usable from mobile apps, scripts and
> tests. Moving the refresh token to a cookie is Exercise 4.

### Concept 6: Validation with Zod + type providers

`fastify-type-provider-zod` lets routes use Zod schemas directly:

```ts
app.post('/register', { schema: { body: RegisterBody, response: { 201: AuthResponse } } }, …)
```

That one line gives us three things:

1. **Validation:** bad input is rejected with 400 before our handler runs.
2. **Types:** `request.body` is automatically typed as `{ email: string; … }`.
3. **Safe output:** the response is serialized through `AuthResponse`, so fields not in
   the schema (like `passwordHash`) are dropped. Defense in depth: even if we accidentally
   return the whole DB row, the hash never leaves the server.

Schemas can also *transform*: `Email` trims and lowercases, so `" Alice@X.com "` and
`"alice@x.com"` are the same account.

### Concept 7: One error format

Every error now looks like:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Request validation failed",
             "details": [{ "path": "/email", "message": "Invalid email address" }] } }
```

- `code` is stable and machine-readable. Frontends switch on it.
- `message` is for humans and can change.
- Unknown errors become a generic 500. The full error goes to the logs, never to the client
  (stack traces and SQL help attackers).

We also tell the logger to **redact** the `Authorization` header so tokens never end up in
log files.

### Concept 8: Uniqueness belongs to the database

To reject duplicate emails we *don't* do "check if exists, then insert". Two signups at the
same moment could both pass the check. Instead the DB has a `UNIQUE` index on `email`, we
just insert, and turn Prisma's `P2002` error into `409 EMAIL_TAKEN`. Let the database
enforce invariants; it's the only component that sees every write.

### Concept 9: Rate limiting

`@fastify/rate-limit` allows `AUTH_RATE_LIMIT_MAX` (default 10) login/register/refresh
attempts per IP per minute, then returns `429 RATE_LIMITED`. That turns "try a million
passwords" into "try 10 a minute". It's off globally (`global: false`) and enabled per
route via `config.rateLimit`.

### Concept 10: Testing auth properly

Tests now run against migrated tables, and `resetDb()` truncates them before each test so
tests can't affect each other. `fileParallelism: false` stops two test files from fighting
over the same database.

Look at *what* we test: not just the happy path, but the attacks. Tampered token, expired
token, reused refresh token, duplicate email in different case, timing-safe error messages,
brute force. Security code is mostly about the unhappy paths.

### Build it yourself

1. Add the `User` model, run a migration, read the generated SQL.
2. Write `POST /auth/register` that hashes with argon2 and returns the user (no tokens yet).
   Write a test proving the hash isn't the password.
3. Add `@fastify/jwt`, return an access token, and add `GET /users/me` guarded by
   `app.authenticate`. Test with and without the token.
4. Add `POST /auth/login` with the dummy-hash trick.
5. Add the `RefreshToken` model, then `/auth/refresh` with rotation. Write the reuse test
   *first*, watch it fail, then implement family revocation.
6. Add the error handler and rate limiting.

### Exercises

1. **Read a JWT.** Register with curl, copy the `accessToken`, and decode the middle part:
   `echo '<payload>' | base64 -d`. What fields do you see? Why is it fine that it's readable?
2. **Change password.** Add `POST /users/me/password` taking `currentPassword` and
   `newPassword`. It should verify the current one, update the hash, and revoke **all** the
   user's refresh tokens. Write tests.
3. **Logout everywhere.** Add `POST /auth/logout-all` (authenticated) that revokes every
   refresh token for the user.
4. **Cookies.** Make `/auth/login` also set the refresh token as an
   `HttpOnly; Secure; SameSite=Strict` cookie using `@fastify/cookie`, and let
   `/auth/refresh` read it from there.
5. **Think about it.** Why do we hash refresh tokens with SHA-256 but passwords with
   argon2? What would go wrong if we swapped them?

### Words to know

migration · hash · salt · argon2id · JWT · signature · HMAC · claims (`sub`, `exp`) ·
access token · refresh token · token rotation · reuse detection · user enumeration ·
timing attack · rate limiting · 401 vs 403 vs 409 vs 429 · idempotent · defense in depth
