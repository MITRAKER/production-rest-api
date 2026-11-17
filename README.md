# Production REST API

A production-style REST API for a team task tracker, built with **TypeScript, Fastify and PostgreSQL**.
Users sign up, create workspaces, invite members with roles, and manage projects and tasks.

> 📘 New to the code? Read [LEARNING.md](./LEARNING.md): it explains every step, the design decisions and the concepts behind them.

## Tech stack

| Area | Choice |
| ---- | ------ |
| Language | TypeScript (Node.js 22) |
| Web framework | Fastify 5 |
| Database | PostgreSQL 16 with Prisma ORM |
| Validation | Zod (via fastify-type-provider-zod) |
| Auth | JWT access tokens, rotating refresh tokens, argon2id, rate limiting |
| Testing | Vitest against a real Postgres |
| Packaging | Docker (multi-stage) and Docker Compose |
| CI | GitHub Actions |

## Getting started

```bash
cp .env.example .env
docker compose up -d db      # start Postgres (also creates the api_test database)
npm install
npm run db:migrate           # create the tables
npm run dev                  # http://localhost:3000/health/ready
npm test
```

Or run everything in containers: `docker compose up --build`.

## Scripts

| Command | What it does |
| ------- | ------------ |
| `npm run dev` | Start with auto-reload |
| `npm test` | Run the test suite |
| `npm run typecheck` | Type-check without building |
| `npm run build` / `npm start` | Compile and run the production build |
| `npm run db:migrate` | Create and apply a migration in development |

## Endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/health/live` | Liveness probe (process is up) |
| GET | `/health/ready` | Readiness probe (database reachable) |
| POST | `/auth/register` | Create an account, returns access + refresh tokens |
| POST | `/auth/login` | Log in, returns access + refresh tokens |
| POST | `/auth/refresh` | Exchange a refresh token for a new pair (rotation) |
| POST | `/auth/logout` | Revoke the session's refresh tokens |
| GET | `/users/me` | Current user (requires `Authorization: Bearer <token>`) |

Errors always use one shape: `{ "error": { "code": "EMAIL_TAKEN", "message": "...", "details": [...] } }`.

## Roadmap

- [x] Skeleton, health checks, tests, Docker, CI
- [x] JWT authentication with refresh token rotation
- [ ] Workspaces and role-based access control
- [ ] Projects and tasks with pagination, filtering, sorting
- [ ] Consistent errors, OpenAPI docs
- [ ] Seed data and full test coverage
