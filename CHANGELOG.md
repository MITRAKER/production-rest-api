# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project skeleton: Fastify 5 with TypeScript, PostgreSQL through Prisma, configuration
  validated at startup, liveness and readiness checks, structured logs with request ids,
  graceful shutdown, a multi-stage Docker image and Docker Compose.
- Authentication: register, login, refresh token rotation with reuse detection, logout and
  `GET /users/me`, with argon2id password hashing and rate limiting.
- Workspaces with role-based permissions (owner, admin, member): create, list, rename and
  delete workspaces; list members, change roles, remove members or leave; invite by email
  with single-use, expiring tokens. Outsiders get `404`, you can only act on people with a
  lower role than yours, a lock on each workspace keeps at least one owner in it, and quotas
  limit workspaces per user, members per workspace and pending invitations
  (`409 LIMIT_REACHED`).
- Projects and tasks inside workspaces. Admins manage projects; every member reads, creates
  and edits tasks, and deletes the ones they created (admins can delete any). A task has a
  status, a priority, an optional due date and an optional assignee, who must be a member:
  removing a member unassigns their tasks. Lists use keyset (cursor) pagination with
  opaque cursors, filters (status, priority, assignee, due date range, title search) and
  sorting (by creation, last update or due date, with undated tasks last). New quotas limit
  projects per workspace (20 by default) and tasks per project (5,000), and together they
  may not allow more than 100,000 tasks in one workspace.
- API documentation: an OpenAPI 3.1 document generated from the route schemas, served at
  `/docs/json` with an interactive page at `/docs`, and committed as `openapi.json` so that
  every change to the API shows in code review. Every route has a name, a summary, a group
  and a description of each answer it can give, with an example of each error.
- A catalog of error codes. Every error answer uses a code from one list, and is checked
  against the documented `Error` schema before it is sent. The errors Fastify raises itself
  get our codes (`INVALID_JSON`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`,
  `BAD_REQUEST`) instead of its internal names, including those it raises before it finds a
  route.
- Logs: every line logged after the token checks out names the user, reusing a refresh token
  logs a warning, and an `x-request-id` from a proxy is kept when it looks like an id, so one
  id follows a request through every service.
- Quality gates: the strictest TypeScript settings, ESLint with the NASA/JPL "Power of Ten"
  rules (including a custom rule that bans recursion), Prettier, Git hooks (Husky,
  lint-staged, commitlint) and a test coverage threshold.
- CI/CD with GitHub Actions: formatting, lint, types, tests with coverage, commit message and
  pull request title checks, dependency audit, a Docker build with a smoke test and Trivy
  scans, CodeQL, dependency review, OpenSSF Scorecard, Dependabot, and a release workflow that
  publishes Docker images to GitHub Container Registry.
- Project documents: contributing guide, security policy, code of conduct, issue and pull
  request templates, CODEOWNERS, EditorConfig.

### Security

- Explicit resource limits: request body size, request timeout, database pool size,
  connection, statement and transaction timeouts, and a maximum length on every input string.
- A sign-up and its first session are created in one transaction, and refresh token rotation
  asserts that a session has exactly one live token.
- Logging out, or reusing an old refresh token, ends the session even while one of its
  tokens is being rotated: rotation and revocation lock the user's row first.
- Project and task lookups are scoped by every id in the URL, project and task writes hold a
  shared lock on the workspace so roles and memberships can't change halfway through (an
  advisory lock with a fair queue, so a stream of task edits can't hold up a member's
  removal), and pagination cursors are validated like any other input, including the dates
  inside them, and only work for the list they were made for. Title search escapes `LIKE`
  wildcards.
- No input string may contain the NUL character, which Postgres text can't store: it gets
  a `400` instead of failing in the database with a `500`. Half of a UTF-16 surrogate pair
  gets a `400` too, instead of being stored as `�`. The login password is the exception: it
  is never stored, and accounts created before this rule must still be able to log in.
- Ids from clients are checked only for their shape and lower-cased, so ids written in
  capitals work everywhere, including the next page of a list and leaving a workspace.
- Routes that need a token check it before reading or validating anything: without a valid
  token the answer is `401`, never a validation error that describes the expected request.
- The API reads JSON only: a body of any other type, `text/plain` included, gets `415`.
- Error messages never repeat a URL's query string, and the errors Fastify raises before
  routing get an `x-request-id` like every other answer from the API.
- A test checks that no password or token reaches the logs, even at the `trace` level.
- Both Docker images are pinned by digest, run on Node.js 26 LTS as a non-root user and get
  the latest Alpine security fixes. Neither ships npm, and the API image leaves out the
  Prisma CLI.
- The Prisma CLI's `effect` dependency is raised to a version without the ReDoS in
  [GHSA-7589-6fvf-x4pw](https://github.com/advisories/GHSA-7589-6fvf-x4pw), with an npm
  override, until Prisma ships one.

[Unreleased]: https://github.com/MITRAKER/production-rest-api/commits/main
