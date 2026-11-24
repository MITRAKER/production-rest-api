// @ts-check
/**
 * Commit messages (and PR titles) follow Conventional Commits:
 *   feat: add workspace invitations
 *   fix(auth): reject reused refresh tokens
 * See https://www.conventionalcommits.org and CONTRIBUTING.md.
 *
 * @type {import('@commitlint/types').UserConfig}
 */
const config = {
  extends: ['@commitlint/config-conventional'],
  // Dependabot's commits are skipped: their bodies contain long release-note
  // lines that would break the line-length rules, and its grouped updates
  // start with a capital ("Bump the … group"). Its commits are recognizable by
  // their sign-off. pr-title.yml skips its pull request titles for the same
  // reason; .github/dependabot.yml gives them the right type and scope.
  ignores: [(message) => message.includes('Signed-off-by: dependabot[bot]')],
};

export default config;
