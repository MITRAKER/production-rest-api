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
  // Dependabot's titles follow the convention (see .github/dependabot.yml),
  // but its commit bodies contain long release-note lines that would break
  // the line-length rules. Its commits are recognizable by their sign-off.
  ignores: [(message) => message.includes('Signed-off-by: dependabot[bot]')],
};

export default config;
