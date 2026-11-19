## What and why

<!-- What does this change do, and why is it needed? Link the issue it closes: "Closes #123". -->

## Type of change

<!-- The pull request title must follow Conventional Commits, for example "feat(tasks): add pagination". -->

- [ ] `feat`: a new feature
- [ ] `fix`: a bug fix
- [ ] `refactor` / `perf`: no change in behavior
- [ ] `docs` / `test` / `ci` / `build` / `chore`
- [ ] Breaking change: existing API clients must change (add `!` to the title, explain below)

## How it was tested

<!-- Commands you ran and what you checked. New behavior needs new tests. -->

## Checklist

- [ ] `npm run check` passes locally (formatting, lint, types, tests and coverage)
- [ ] The code follows the Power of Ten rules in [CONTRIBUTING.md](https://github.com/MITRAKER/production-rest-api/blob/main/CONTRIBUTING.md#coding-rules-the-power-of-ten); any new `eslint-disable` has a reason
- [ ] All new input is validated with bounded Zod schemas (maximum lengths and sizes)
- [ ] Tests cover the unhappy paths (400, 401, 403, 404, 409) as well as the happy path
- [ ] Database changes come with a migration, and I read the generated SQL
- [ ] README, LEARNING.md and CHANGELOG.md (under `[Unreleased]`) are updated where needed
- [ ] No secrets, tokens or personal data in code, tests, logs or screenshots
