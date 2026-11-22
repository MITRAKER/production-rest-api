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

| Area          | Choice                                                                        |
| ------------- | ----------------------------------------------------------------------------- |
| Language      | TypeScript 6 (strictest settings) on Node.js 26 LTS                           |
| Web framework | Fastify 5                                                                     |
| Database      | PostgreSQL 16 with Prisma ORM                                                 |
| Validation    | Zod (via fastify-type-provider-zod)                                           |
| Auth          | JWT access tokens, rotating refresh tokens, argon2id, rate limiting           |
| Authorization | Role-based (owner / admin / member), with row locks protecting the invariants |
| Testing       | Vitest against a real Postgres, with a coverage threshold                     |
| Code quality  | ESLint with the NASA/JPL "Power of Ten" rules, Prettier, commitlint, Husky    |
| Security      | CodeQL, dependency review, npm audit, Trivy, OpenSSF Scorecard, Dependabot    |
| Packaging     | Docker (multi-stage, pinned by digest, non-root) and Docker Compose           |
| CI/CD         | GitHub Actions; tagged releases publish images to GitHub Container Registry   |

## Getting started

```bash
nvm use                      # Node.js 26, from .nvmrc
cp .env.example .env
docker compose up -d db      # start Postgres (also creates the api_test database)
npm install                  # also installs the Git hooks
npm run db:migrate           # create the tables
npm run dev                  # http://localhost:3000/health/ready
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

## Endpoints

| Method               | Path                                                 | Description                                             |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| GET                  | `/health/live`                                       | Liveness probe (process is up)                          |
| GET                  | `/health/ready`                                      | Readiness probe (database reachable)                    |
| POST                 | `/auth/register`                                     | Create an account, returns access + refresh tokens      |
| POST                 | `/auth/login`                                        | Log in, returns access + refresh tokens                 |
| POST                 | `/auth/refresh`                                      | Exchange a refresh token for a new pair (rotation)      |
| POST                 | `/auth/logout`                                       | Revoke the session's refresh tokens                     |
| GET                  | `/users/me`                                          | Current user (requires `Authorization: Bearer <token>`) |
| POST                 | `/workspaces`                                        | Create a workspace (you become its owner)               |
| GET                  | `/workspaces`                                        | Workspaces you belong to, with your role                |
| GET / PATCH / DELETE | `/workspaces/:workspaceId`                           | Read (member), rename (admin+), delete (owner)          |
| GET                  | `/workspaces/:workspaceId/members`                   | List members and roles                                  |
| PATCH / DELETE       | `/workspaces/:workspaceId/members/:userId`           | Change role (owner), remove or leave                    |
| POST / GET           | `/workspaces/:workspaceId/invitations`               | Invite by email, list pending (admin+)                  |
| DELETE               | `/workspaces/:workspaceId/invitations/:invitationId` | Revoke an invitation (admin+)                           |
| POST                 | `/invitations/accept`                                | Join a workspace with an invitation token               |

Everything except `/health/*` and `/auth/*` requires `Authorization: Bearer <accessToken>`.
Non-members get `404` for a workspace's routes, and members without the needed role get `403`.

Errors always use one shape:
`{ "error": { "code": "EMAIL_TAKEN", "message": "...", "details": [...] } }`.

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
- [ ] Projects and tasks with pagination, filtering, sorting
- [ ] Consistent errors, OpenAPI docs
- [ ] Seed data and a recruiter-ready README

## License

[MIT](./LICENSE)
