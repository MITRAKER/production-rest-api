# Production REST API

[![CI](https://github.com/MITRAKER/production-rest-api/actions/workflows/ci.yml/badge.svg)](https://github.com/MITRAKER/production-rest-api/actions/workflows/ci.yml)
[![CodeQL](https://github.com/MITRAKER/production-rest-api/actions/workflows/codeql.yml/badge.svg)](https://github.com/MITRAKER/production-rest-api/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/MITRAKER/production-rest-api/badge)](https://scorecard.dev/viewer/?uri=github.com/MITRAKER/production-rest-api)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![TypeScript: strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](./tsconfig.json)
[![Code style: Prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](./.prettierrc.json)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-fe5196.svg)](https://www.conventionalcommits.org/en/v1.0.0/)

A production-style REST API for a team task tracker, built with **TypeScript, Fastify and
PostgreSQL**. Users sign up, create workspaces, invite members with roles, and manage projects
and tasks.

> 📘 New to the code? Read [LEARNING.md](./LEARNING.md): it explains every step, the design
> decisions and the concepts behind them.

## Tech stack

| Area          | Choice                                                                             |
| ------------- | ---------------------------------------------------------------------------------- |
| Language      | TypeScript 6 (strictest settings) on Node.js 26 LTS                                |
| Web framework | Fastify 5                                                                          |
| Database      | PostgreSQL 16 with Prisma ORM                                                      |
| Validation    | Zod (via fastify-type-provider-zod)                                                |
| Auth          | JWT access tokens, rotating refresh tokens, argon2id, rate limiting                |
| Authorization | Role-based (owner / admin / member), with database locks protecting the invariants |
| API design    | Nested resources, keyset (cursor) pagination, allow-listed filters and sorts       |
| API docs      | OpenAPI 3.1 generated from the Zod schemas, Swagger UI at `/docs`                  |
| Testing       | Vitest against a real Postgres, with a coverage threshold                          |
| Code quality  | ESLint with the NASA/JPL "Power of Ten" rules, Prettier, commitlint, Husky         |
| Security      | CodeQL, dependency review, npm audit, Trivy, OpenSSF Scorecard, Dependabot         |
| Packaging     | Docker (multi-stage, pinned by digest, non-root) and Docker Compose                |
| CI/CD         | GitHub Actions; tagged releases publish images to GitHub Container Registry        |

## Getting started

```bash
nvm use                      # Node.js 26, from .nvmrc
cp .env.example .env
docker compose up -d db      # start Postgres (also creates the api_test database)
npm install                  # also installs the Git hooks
npm run db:migrate           # create the tables
npm run dev                  # API docs at http://localhost:3000/docs
npm run check                # everything CI checks: format, lint, types, tests
```

Or run everything in containers: `docker compose up --build`.

## Scripts

| Command                       | What it does                                                 |
| ----------------------------- | ------------------------------------------------------------ |
| `npm run dev`                 | Start with auto-reload                                       |
| `npm run check`               | Run every check CI runs: format, lint, types, tests          |
| `npm test`                    | Run the test suite                                           |
| `npm run test:coverage`       | Run the tests and fail if coverage is below the thresholds   |
| `npm run lint` / `lint:fix`   | Lint with zero warnings allowed / fix what can be auto-fixed |
| `npm run format`              | Format every file with Prettier                              |
| `npm run typecheck`           | Type-check without building                                  |
| `npm run build` / `npm start` | Compile and run the production build                         |
| `npm run db:migrate`          | Create and apply a migration in development                  |
| `npm run openapi`             | Rewrite `openapi.json` after changing a route                |

## Endpoints

The full reference is generated from the code. Start the API and open
[`localhost:3000/docs`](http://localhost:3000/docs): every route, what it accepts, what it
answers and why, with an **Authorize** button and "Try it out" to send real requests. The
OpenAPI 3.1 document behind that page is served at `/docs/json` and committed as
[`openapi.json`](./openapi.json), ready for Postman or a client generator. An overview:

| Method               | Path                                                         | Description                                              |
| -------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| GET                  | `/health/live`                                               | Liveness probe (process is up)                           |
| GET                  | `/health/ready`                                              | Readiness probe (database reachable)                     |
| GET                  | `/docs`, `/docs/json`                                        | API documentation, and the OpenAPI document behind it    |
| POST                 | `/auth/register`                                             | Create an account, returns access + refresh tokens       |
| POST                 | `/auth/login`                                                | Log in, returns access + refresh tokens                  |
| POST                 | `/auth/refresh`                                              | Exchange a refresh token for a new pair (rotation)       |
| POST                 | `/auth/logout`                                               | Revoke the session's refresh tokens                      |
| GET                  | `/users/me`                                                  | Current user (requires `Authorization: Bearer <token>`)  |
| POST                 | `/workspaces`                                                | Create a workspace (you become its owner)                |
| GET                  | `/workspaces`                                                | Workspaces you belong to, with your role                 |
| GET / PATCH / DELETE | `/workspaces/:workspaceId`                                   | Read (member), rename (admin+), delete (owner)           |
| GET                  | `/workspaces/:workspaceId/members`                           | List members and roles                                   |
| PATCH / DELETE       | `/workspaces/:workspaceId/members/:userId`                   | Change role (owner), remove or leave                     |
| POST / GET           | `/workspaces/:workspaceId/invitations`                       | Invite by email, list pending (admin+)                   |
| DELETE               | `/workspaces/:workspaceId/invitations/:invitationId`         | Revoke an invitation (admin+)                            |
| POST                 | `/invitations/accept`                                        | Join a workspace with an invitation token                |
| POST / GET           | `/workspaces/:workspaceId/projects`                          | Create a project (admin+), list projects                 |
| GET / PATCH / DELETE | `/workspaces/:workspaceId/projects/:projectId`               | Read (member), rename, or delete with its tasks (admin+) |
| POST / GET           | `/workspaces/:workspaceId/projects/:projectId/tasks`         | Create a task (member), list with filters and sorting    |
| GET / PATCH / DELETE | `/workspaces/:workspaceId/projects/:projectId/tasks/:taskId` | Read, edit (member), delete (its creator or admin+)      |

Everything except `/health/*`, `/auth/*` and `/docs` requires
`Authorization: Bearer <accessToken>`, and without a valid one the answer is `401` before the
request body is even read. Non-members get `404` for a workspace's routes, and members without
the needed role get `403`.

Project and task lists come one page at a time: `?limit=` sets the page size (20 by default,
at most 100), and the response's `nextCursor` gets the next page (`&cursor=…`) until it is
`null`. Tasks can be filtered by `status`, `priority`, `assigneeId` (or `none`), a due date
range (`dueFrom`, `dueTo`) and title text (`q`), and sorted by `createdAt`, `updatedAt` or
`dueDate` (`order=asc` or `desc`). [LEARNING.md](./LEARNING.md) chapter 5 explains how it
works.

## Errors

Every error answer has the same shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": "/email", "message": "Invalid email address" }]
  }
}
```

Programs switch on `code`: a code never changes once released. The `message` is for people,
and its wording may change. `details` comes only with `VALIDATION_ERROR`, one entry per
problem. Every code, by status:

| Status | Codes                                                                                      |
| ------ | ------------------------------------------------------------------------------------------ |
| 400    | `VALIDATION_ERROR`, `INVALID_JSON`, `INVALID_CURSOR`, `ASSIGNEE_NOT_MEMBER`, `BAD_REQUEST` |
| 401    | `UNAUTHORIZED`, `INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN`                             |
| 403    | `FORBIDDEN`, `INVITATION_EMAIL_MISMATCH`                                                   |
| 404    | `NOT_FOUND`, `INVITATION_NOT_FOUND`                                                        |
| 409    | `EMAIL_TAKEN`, `LAST_OWNER`, `ALREADY_MEMBER`, `INVITATION_PENDING`, `LIMIT_REACHED`       |
| 410    | `INVITATION_EXPIRED`                                                                       |
| 413    | `PAYLOAD_TOO_LARGE` (a body over 64 KB)                                                    |
| 414    | `BAD_REQUEST` (an id in the path longer than 100 characters)                               |
| 415    | `UNSUPPORTED_MEDIA_TYPE` (a body in a format the API doesn't read, such as a form)         |
| 429    | `RATE_LIMITED` (too many login, sign-up or refresh attempts)                               |
| 500    | `INTERNAL_ERROR`, with a generic message: the details only go to the logs                  |

`/docs` lists the statuses each route can answer, with an example of each. The one answer in
another shape is the readiness probe's `503`, `{ "status": "error", "database": "down" }`,
which is meant for load balancers.

Every answer carries an `x-request-id` header. Quote it in a bug report: it finds that
request's lines in the logs. A proxy in front of the API can send its own `x-request-id`, and
the API keeps it if it looks like an id (letters, digits and `-_.:`, at most 128 characters),
so one id follows the request through every service.

## Quality and security

Every pull request must pass formatting, lint, type, test and coverage checks, commit message
checks, a dependency audit, a Docker build with a smoke test and a vulnerability scan, CodeQL
and dependency review. The code follows the NASA/JPL "Power of Ten" rules for safety-critical
code, adapted to TypeScript and enforced by ESLint: no recursion, bounded loops, explicit
resource limits, short functions, assertions, and zero warnings.

- [CONTRIBUTING.md](./CONTRIBUTING.md): setup, workflow, coding rules, tests and releases
- [SECURITY.md](./SECURITY.md): how to report a vulnerability, and the defenses in place
- [CHANGELOG.md](./CHANGELOG.md): what changed in each release
- [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md): how we work together

## Roadmap

- [x] Skeleton, health checks, tests, Docker, CI
- [x] JWT authentication with refresh token rotation
- [x] Professional quality: CI/CD, security scanning, NASA/JPL coding rules
- [x] Workspaces, invitations and role-based access control
- [x] Projects and tasks with pagination, filtering, sorting
- [x] Consistent errors, logs and OpenAPI docs
- [ ] Seed data and a recruiter-ready README

## License

[MIT](./LICENSE)
