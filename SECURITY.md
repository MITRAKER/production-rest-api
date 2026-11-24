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
- **The token is checked first.** On every protected route, the access token is checked in
  the very first step of a request (Fastify's `onRequest` hook). Without a valid one the
  answer is `401` before anything else is read or validated, so a stranger can't make the
  API parse a body, or learn from a validation error what a request should contain. A test
  sends every protected route in the OpenAPI document an invalid id, an invalid query and a
  broken body, without a token, and expects `401`.
- **Workspaces** check membership before anything else, so outsiders get `404` and can't
  even learn that a workspace exists. Roles are checked in one policy file, and you can only
  act on people with a lower role than yours. Every change that could leave a workspace
  without an owner or over a quota runs under a lock on that workspace, so simultaneous
  requests can't do either.
- **Projects and tasks** are looked up by every id in their URL (workspace, project and
  task), so an id from another workspace is simply not found (`404`). Their changes hold a
  shared lock on the workspace, so a role or membership can't change halfway through one.
  The lock keeps a fair queue: once a membership change is waiting, new changes wait behind
  it, so no stream of requests can hold up removing a member. Tasks can only be assigned to
  members, and removing a member unassigns their tasks in the same transaction.
- **Lists** only sort and filter by allow-listed fields and values, and title search escapes
  `LIKE` wildcards. Pagination cursors are opaque but not secret (they hold nothing the page
  doesn't show). They are validated like any other input: a malformed cursor, one with
  values out of range, or one made for another list or sort order gets
  `400 INVALID_CURSOR`. Cursors aren't signed, so an edited cursor that is still valid is
  accepted; it can only change where the caller resumes a list they can already read.
- **Invitations** are 256-bit random tokens stored only as SHA-256 hashes. They are
  single-use, expire after 7 days by default, and only work for an account with the invited
  email (see the known limitations below).
- **Every input is validated and bounded:** a maximum request body size, a maximum length on
  every string, a maximum page size, request and database timeouts, and a fixed database pool
  size. No string that is stored or searched may contain the NUL character, which Postgres
  can't store, or half of a UTF-16 surrogate pair, which would be stored changed. Ids are
  accepted in any letter case and compared in lower case. Quotas also bound what one request
  may have to touch: at most 100,000 tasks in a workspace, so even removing a member who is
  assigned all of them stays well inside the timeouts.
- **Errors never leak internals.** Unexpected errors are logged in full, and the client only
  gets a generic `500 INTERNAL_ERROR`. Every error answer uses a code from one fixed list,
  and is checked against the documented `Error` schema before it is sent: one that doesn't
  fit becomes that generic `500`, never a body in another shape. Fastify's internal error
  names (`FST_ERR_…`) are translated to our codes, and the errors Fastify raises before it
  finds a route (a malformed URL, an overlong id) get the same shape. Error messages name
  the path of a URL but never repeat its query string.
- **Logs never hold a secret.** The API takes passwords and tokens only in headers and
  bodies, never in a URL, because URLs are logged (as in any web server's access log).
  Bodies are never logged, the `Authorization` and `Cookie` headers are redacted, and a test
  records every log line at the most verbose level (`trace`) through a sign-up, a login, a
  token refresh, an invitation, a failed login and a bad token, then checks that no password
  or token appears anywhere. Every line logged after the token checks out names the user's
  id, and reusing a refresh token is logged as a warning, naming the user and the session
  (never the token). A request id from upstream (`x-request-id`) is kept only if it looks
  like an id (letters, digits and `-_.:`, at most 128 characters). Any client can send one,
  so it's used to find log lines, never trusted for anything else.
- **The API documentation is public on purpose.** `/docs` and the OpenAPI document describe
  what any client learns by using the API, and hold no secrets or internal details. Its page
  is served with a strict Content-Security-Policy: no inline scripts, and scripts only from
  the API itself.
- **The Docker images** (the API and the migration job) run as a non-root user, are pinned by
  digest and get the latest Alpine security fixes. Neither has npm, npx or yarn, and the API
  image has no development dependencies.

## Known limitations

These are known and planned, so they don't need a report:

- **Email addresses aren't verified yet.** Anyone can register any email address. So if the
  person invited has no account yet, an invitation link works for whoever registers that
  email first. Share invitation links only with the person invited.
- **Stored history grows.** Revoked or used refresh tokens and invitations are kept, and
  nothing deletes them yet. A cleanup job is planned.

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
