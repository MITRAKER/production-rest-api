# Security policy

## Supported versions

Security fixes go into `main` and ship in the next release. Only the latest release is
supported.

## Reporting a vulnerability

**Please don't report security problems in public issues, discussions or pull requests.**

Report them privately through GitHub instead:
[open a private vulnerability report](https://github.com/MITRAKER/production-rest-api/security/advisories/new)
(the **Security** tab, then **Report a vulnerability**). Only the maintainer can see it.

Please include:

- what the problem is and what an attacker could do with it,
- the steps or a request that reproduces it (method, path, body),
- the version or commit you tested,
- a suggested fix, if you have one.

## What happens next

This is a project maintained by one person, so these are best-effort targets:

- **Within 7 days:** you get a reply confirming the report was received.
- **Within 30 days:** the problem is confirmed or explained, and fixed if it's real.
- Once a fix is released, the advisory is published, crediting you unless you'd rather stay
  anonymous.

Please give us a reasonable time to fix the problem before you disclose it publicly.

## How the API protects itself

These are the defenses in place today. A report showing that one of them can be bypassed is
exactly what we want to hear about.

- **Passwords** are hashed with argon2id, which is slow and memory-hard on purpose, with a
  random salt per user. Hashing costs real CPU, so the authentication endpoints are rate
  limited.
- **Access tokens** are short-lived JWTs (15 minutes) signed with HS256; the algorithm is
  pinned when verifying.
- **Refresh tokens** are 256-bit random values stored only as SHA-256 hashes. They rotate on
  every use, and reusing an old one revokes the whole session. Rotations and revocations of
  one user's sessions run one at a time, so a logout can't miss a token that is being rotated
  at that very moment.
- **Login** returns the same error, in the same time, for an unknown email and a wrong
  password. Registration does tell whether an email is already taken (`409`), like most
  sign-up forms; avoiding that would need email verification.
- **Rate limiting** on the authentication endpoints slows down brute-force attacks.
- **Every input is validated and bounded:** a maximum request body size, a maximum length on
  every string, request and database timeouts, and a fixed database pool size.
- **Errors never leak internals:** unexpected errors return a generic 500, and the
  `Authorization` and `Cookie` headers are redacted from the logs.
- **The Docker images** (the API and the migration job) run as a non-root user, are pinned by
  digest and get the latest Alpine security fixes. Neither has npm, npx or yarn, and the API
  image has no development dependencies.

## How the code is checked

Every pull request runs:

- **CodeQL** static analysis for security bugs, in the code and in the GitHub Actions
  workflows;
- **dependency review**, which blocks a pull request that adds or updates a dependency
  (production or development) with a known high-severity vulnerability or an unexpected
  license;
- **npm audit** on the production dependencies, and **npm audit signatures** to verify that
  every package came unmodified from the npm registry;
- a **Trivy** scan of both Docker images.

Every GitHub Action is pinned to a commit SHA, workflows get read-only tokens unless a job
needs more, **Dependabot** keeps dependencies up to date, and **OpenSSF Scorecard** grades the
repository's security practices every week.
