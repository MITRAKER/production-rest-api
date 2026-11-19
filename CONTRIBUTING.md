# Contributing

Thanks for helping improve this project. This guide explains how to set up your machine, how a
change travels from a branch to `main`, the quality rules every change follows, and how releases
are made. It's written with beginners in mind, so skip what you already know.

Everyone who takes part agrees to follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Found a
security problem? Please don't open an issue: follow [SECURITY.md](./SECURITY.md) instead.

## Ways to contribute

- **Report a bug or suggest a feature** with the
  [issue forms](https://github.com/MITRAKER/production-rest-api/issues/new/choose).
- **Improve the docs**, including [LEARNING.md](./LEARNING.md). If something confused you, it
  will confuse the next person too.
- **Send a pull request.** For anything bigger than a small fix, open an issue first so we can
  agree on the approach before you spend time on it.

## Prerequisites

- **Node.js 26** (the Active LTS line). The version is pinned in [`.nvmrc`](./.nvmrc). With
  [nvm](https://github.com/nvm-sh/nvm), run `nvm install` once, then `nvm use` in the project
  folder.
- **Docker** with Docker Compose v2 (the `docker compose` command). It runs PostgreSQL 16 for
  you. Docker Desktop includes both.
- **Git.**

## Set up the project

Clone the repository (or your fork, if you don't have write access) and run:

```bash
git clone https://github.com/MITRAKER/production-rest-api.git
cd production-rest-api
nvm use                    # switch to Node.js 26 (from .nvmrc)
cp .env.example .env       # local settings; .env is never committed
docker compose up -d db    # PostgreSQL 16 with the api_dev and api_test databases
npm install                # dependencies, plus the Git hooks (through Husky)
npm run db:migrate         # create the tables in api_dev
npm run dev                # start the API on http://localhost:3000 with auto-reload
```

Check that it works: open `http://localhost:3000/health/ready`, then run `npm test` in a second
terminal.

> **Tip:** Postgres creates the `api_test` database only when its data volume is first created.
> If the tests say that database doesn't exist, recreate the volume with
> `docker compose down -v && docker compose up -d db` (this deletes your local dev data).

## How to make a change

1. Start from an up-to-date `main` and create a branch named `<type>/<short-description>`:

   ```bash
   git switch main
   git pull
   git switch -c feat/task-pagination
   ```

2. Make the change in small commits, with tests (see [Writing tests](#writing-tests)).
3. Run `npm run check`. It runs the same format, lint, type and test checks as CI.
4. Push the branch and open a pull request against `main`. Give it a
   [Conventional Commits](#commit-messages-and-pull-request-titles) title and fill in the
   template.
5. Address review comments with new commits rather than force-pushing, so reviewers can see what
   changed.
6. Once CI is green and the review is approved, the maintainer merges it.

### Keep pull requests small and focused

One pull request, one purpose: a feature, a fix or a refactor, not all three. Small PRs get
reviewed sooner, are easier to understand and are safe to revert. If a change is large, split it
into a stack of PRs where each one builds on the one before it.

### Merging stacked pull requests

In a stack, each PR targets the branch of the PR below it instead of `main`. Merge the PRs **in
order, bottom first, with "Create a merge commit"**, never with "Squash and merge" or "Rebase and
merge". A merge commit keeps the commits that the next PR is built on. Squashing or rebasing
rewrites them, so the next PR would show those changes again and could conflict.

After merging a PR, delete its branch (the **Delete branch** button on the merged PR, or turn on
**Automatically delete head branches** in the repository settings). GitHub then retargets the
next PR in the stack to `main`. If the branch is kept, the next PR still targets it, and
merging that PR puts its commits on the old branch instead of `main`. So before merging a
stacked PR, check that the top of the page says it will merge into `main`.

## Commit messages and pull request titles

Both follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>(<optional scope>): <short summary>
```

| Type       | Use it for                                                | Example                                      |
| ---------- | --------------------------------------------------------- | -------------------------------------------- |
| `feat`     | A new feature                                             | `feat(tasks): add cursor pagination`         |
| `fix`      | A bug fix                                                 | `fix(workspaces): return 404 for a bad id`   |
| `docs`     | Documentation only                                        | `docs(learning): add exercises on row locks` |
| `test`     | Adding or fixing tests                                    | `test(invitations): cover expired tokens`    |
| `refactor` | A code change that neither fixes a bug nor adds a feature | `refactor(auth): extract token issuing`      |
| `perf`     | A performance improvement                                 | `perf(tasks): index tasks by due date`       |
| `build`    | Build system, Docker image or dependencies                | `build(deps): bump fastify to 5.13.0`        |
| `ci`       | CI workflows                                              | `ci: cache the npm dependencies`             |
| `chore`    | Maintenance that doesn't change `src` or `test`           | `chore(release): v1.1.0`                     |

- The scope is optional: use the module or area you changed (`auth`, `workspaces`, `deps`...).
- Write the summary in lowercase and in the imperative ("add", not "added" or "Adds"), with no
  final period. Keep the whole first line under 100 characters.
- Mark a breaking change with `!` after the type or scope (`feat(api)!: rename the error field`)
  and explain it in a `BREAKING CHANGE:` footer.
- commitlint also accepts `style` and `revert`.

## Git hooks

`npm install` sets up three Git hooks with [Husky](https://typicode.github.io/husky/):

- **pre-commit** runs [lint-staged](https://github.com/lint-staged/lint-staged): `eslint --fix`
  and `prettier --write` on the files you staged (not the whole project), and adds the fixes to
  your commit. If ESLint finds a problem it can't fix, the commit stops and shows you the error.
- **commit-msg** runs [commitlint](https://commitlint.js.org/), which rejects messages that don't
  follow Conventional Commits:

  ```bash
  git commit -m "Added pagination"            # rejected: no type
  git commit -m "feat(tasks): add pagination" # accepted
  ```

- **pre-push** runs `npm run typecheck`, so a branch with type errors never leaves your
  machine.

The hooks are a fast safety net, not the gate. CI runs the same format and lint checks on every
pull request, so skipping the hooks only moves the failure to your PR.

## Quality gates

CI runs these checks on every pull request (see [`.github/workflows`](./.github/workflows)),
and all of them must pass before merging:

| Check              | Command or tool                     | Passes when                                                                                                           |
| ------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Formatting         | `npm run format:check`              | Every file is formatted by Prettier                                                                                   |
| Lint               | `npm run lint`                      | ESLint reports no errors and no warnings (`--max-warnings 0`)                                                         |
| Types              | `npm run typecheck`                 | The TypeScript compiler finds no errors in `src`, `test` and `scripts`                                                |
| Tests and coverage | `npm run test:coverage`             | All tests pass against PostgreSQL 16 and coverage meets the thresholds                                                |
| Commit messages    | commitlint                          | Every commit follows Conventional Commits                                                                             |
| Pull request title | commitlint                          | The title follows Conventional Commits (checked again whenever you edit it)                                           |
| Dependency audit   | `npm audit`, `npm audit signatures` | No high or critical vulnerability in production dependencies; all signatures valid                                    |
| Docker images      | `docker build`, smoke test, Trivy   | Both build; one migrates a real database, the other starts and serves requests; no fixable high or critical CVE       |
| Code scanning      | CodeQL                              | No new security alerts in the code or the workflows                                                                   |
| Dependency review  | GitHub dependency review            | No added or updated dependency (production or development) has a high-severity vulnerability or an unexpected license |

`npm run check` runs the first four exactly as CI does, so run it before you push. To fix
problems quickly, `npm run format` formats everything and `npm run lint:fix` fixes what
ESLint can fix on its own. Coverage thresholds are set in `vitest.config.ts`.

## Coding rules: the Power of Ten

The code follows NASA/JPL's
["Power of Ten" rules for safety-critical code](https://spinroot.com/gerard/pdf/P10.pdf),
adapted from C to TypeScript. Most of them are enforced by ESLint or the compiler, so CI catches
violations for you. The full explanation, with examples, is in [LEARNING.md](./LEARNING.md)
chapter 3.

| #   | Rule                | In this codebase                                                                                                                     |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Simple control flow | No recursion (custom lint rule), cyclomatic complexity at most 10, nesting depth at most 3                                           |
| 2   | Bounded loops       | Every loop has a fixed upper bound: no `while`, `do...while` or `for...in` (lint); every list and query has a maximum size           |
| 3   | Bounded resources   | Instead of "no dynamic allocation": a request body limit, a max length on every input string, a fixed DB pool size, timeouts         |
| 4   | Short functions     | At most 60 lines per function (lint)                                                                                                 |
| 5   | Assertions          | Validate all input at the boundary with Zod and assert internal invariants with `invariant()`; on failure, fail loudly and roll back |
| 6   | Smallest scope      | `const` by default, no module-level mutable state, no shadowing                                                                      |
| 7   | Check everything    | Check every return value and every promise (no floating promises), and check parameters                                              |
| 8   | No escape hatches   | No `eval`, no `any`, no non-null assertions, no double type assertions; every `eslint-disable` needs a reason                        |
| 9   | Limited indirection | No parameter reassignment, at most 4 parameters, at most 3 nested callbacks                                                          |
| 10  | Zero warnings       | Strictest TypeScript settings, ESLint with `--max-warnings 0`, CodeQL on every pull request                                          |

If a rule really has to be broken, disable it for one line only and give the reason after `--`:

```ts
// eslint-disable-next-line <rule-name> -- <why this is safe here>
```

## Writing tests

Tests use [Vitest](https://vitest.dev/) and live in `test/`, one `*.test.ts` file per area.

- **Real PostgreSQL, no mocks.** A mock can accept a query that real Postgres would reject. Tests
  use the `api_test` database started by `docker compose up -d db`; the connection settings are
  in `.env.test`. Set `TEST_DATABASE_URL` to point a run at another database.
- **Always the current schema.** Before the run, Vitest's `globalSetup` applies every migration
  with `prisma migrate deploy`.
- **A clean database for each test.** Call `resetDb(app)` in `beforeEach`: it empties every
  table. Test files run one at a time because they share the database.
- **Requests in memory.** `buildTestApp()` builds the app without opening a port, and
  `app.inject()` (or the `client()` and `signUp()` helpers) sends requests through the real
  routing, validation and hooks.
- **Real users.** `signUp(app, 'Alice')` registers a user through the real endpoint and
  returns their id, email and `api`, a small client that sends that user's access token.
  `client(app)` sends requests without a token.
- **The standard cast.** For anything involving permissions, `createTeam(app)` creates the
  workspace "Acme" with **Alice** (OWNER), **Bob** (ADMIN) and **Carol** (MEMBER), plus
  **Dave**, who is not a member. Bob and Carol join through the real invitation flow.
- **Test the unhappy paths.** For each endpoint, check that the allowed role succeeds, the
  next role down gets `403`, Dave gets `404`, a request without a token gets `401` and invalid
  input gets `400`. Then test the invariants: the last owner, quotas, expired or reused tokens
  and simultaneous requests (`Promise.all`).
- **Make race tests really race.** Call `warmUpPool(app)` right before the `Promise.all`.
  Without it, the requests wait for new database connections one by one, run one after the
  other, and the test passes even if the lock it is about is missing. Check every race test
  both ways: it passes with the fix and fails when you remove it.
- **Pure logic gets unit tests.** Code without I/O, like the permission rules in
  `workspaces.policy.ts` or `scripts/changelog-section.mjs`, is
  tested directly, without the database.

```ts
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, client, resetDb, signUp } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb(app);
});

describe('GET /users/me', () => {
  it('returns the logged-in user', async () => {
    const alice = await signUp(app, 'Alice');
    const res = await alice.api.get('/users/me');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: alice.id, email: alice.email });
  });

  it('returns 401 without a token', async () => {
    const res = await client(app).get('/users/me');
    expect(res.statusCode).toBe(401);
  });
});
```

Run one file with `npx vitest run test/auth.test.ts`, and everything with coverage with
`npm run test:coverage` (reports are written to `coverage/`).

## Changing the database schema

Never change a database by hand: every change is a migration file, committed with the code that
needs it.

1. With the database running (`docker compose up -d db`), edit `prisma/schema.prisma`.
2. Create the migration and apply it to your dev database, naming it after the change:

   ```bash
   npm run db:migrate -- --name add_projects
   ```

   Prisma writes the SQL to `prisma/migrations/<timestamp>_add_projects/migration.sql`.

3. Regenerate the typed client so TypeScript knows the new models: `npx prisma generate`.
4. **Read the generated SQL.** Look for dropped tables or columns (data loss), missing indexes
   and the `ON DELETE` behavior of new relations.
5. Commit `schema.prisma` and the new migration folder in the same pull request as the code that
   uses them.

The tests need no extra step: `globalSetup` applies new migrations to `api_test`. In Docker
Compose and in deployments, the `migrate` image runs `prisma migrate deploy` before the API
starts.

- **Never edit a migration that is already on `main`.** It may have run somewhere already. Fix
  mistakes with a new migration instead.
- **Prefer additive changes.** While a new version is being deployed, the old one may still be
  running against the new schema. To rename or drop a column, add the new column in one release
  and remove the old one in a later release.

## Releasing

Releases are for maintainers. Versions follow [Semantic Versioning](https://semver.org/): MAJOR
for breaking API changes, MINOR for new backward-compatible features, PATCH for
backward-compatible fixes.

1. Make sure CI is green on `main`, then update your local copy: `git switch main && git pull`.
2. Bump the version (this updates `package.json` and `package-lock.json`, without committing):

   ```bash
   npm version X.Y.Z --no-git-tag-version
   ```

   For the very first release, `package.json` already says `1.0.0`: skip this step.

3. In `CHANGELOG.md`, move the notes from `## [Unreleased]` to a new `## [X.Y.Z] - YYYY-MM-DD`
   heading (today's date), leave the empty `## [Unreleased]` heading above it, and update the
   links at the bottom of the file:

   ```markdown
   [Unreleased]: https://github.com/MITRAKER/production-rest-api/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/MITRAKER/production-rest-api/compare/vPREVIOUS...vX.Y.Z
   ```

   For the very first release, link `[X.Y.Z]` to
   `https://github.com/MITRAKER/production-rest-api/releases/tag/vX.Y.Z` instead.

4. Commit, tag and push:

   ```bash
   git commit -am "chore(release): vX.Y.Z"
   git push origin main
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

   If branch protection doesn't allow pushing to `main`, merge the release commit through a pull
   request first, then tag the merged commit on `main`.

Pushing the tag starts the Release workflow. It verifies that the tag matches the version in
`package.json` and `CHANGELOG.md`, reruns CI, publishes two Docker images to GitHub Container
Registry, `ghcr.io/mitraker/production-rest-api` (the API) and
`ghcr.io/mitraker/production-rest-api-migrate` (runs `prisma migrate deploy` before a
deploy), and creates the GitHub Release with the notes from `CHANGELOG.md`. New packages on
GitHub Container Registry start private: to let anyone pull them, open each package's
settings and change its visibility to public. If the
verification fails, nothing is published: delete the tag (`git push origin --delete vX.Y.Z` and
`git tag -d vX.Y.Z`), fix the problem and tag again.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
