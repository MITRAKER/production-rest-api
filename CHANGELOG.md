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
- Quality gates: the strictest TypeScript settings, ESLint with the NASA/JPL "Power of Ten"
  rules (including a custom rule that bans recursion), Prettier, Git hooks (Husky,
  lint-staged, commitlint) and a test coverage threshold.
- CI/CD with GitHub Actions: formatting, lint, types, tests with coverage, commit message
  checks, dependency audit, a Docker build with a smoke test and a Trivy scan, CodeQL,
  dependency review, OpenSSF Scorecard, Dependabot, and a release workflow that publishes
  Docker images to GitHub Container Registry.
- Project documents: contributing guide, security policy, code of conduct, issue and pull
  request templates, CODEOWNERS, EditorConfig.

### Security

- Explicit resource limits: request body size, request timeout, database pool size,
  connection and statement timeouts, and a maximum length on every input string.
- A sign-up and its first session are created in one transaction, and refresh token rotation
  asserts that a session has exactly one live token.
- The Docker image is pinned by digest, runs on Node.js 26 LTS, gets the latest Alpine
  security fixes and ships without npm or the Prisma CLI.

[Unreleased]: https://github.com/MITRAKER/production-rest-api/commits/main
