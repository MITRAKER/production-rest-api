// @ts-check
/**
 * Prints the CHANGELOG.md notes for one version. The release workflow uses
 * them as the GitHub release description:
 *
 *   node scripts/changelog-section.mjs 1.2.0
 *
 * Fails if CHANGELOG.md has no "## [1.2.0] - <date>" section, so a version
 * can't be released without notes.
 */
import { readFileSync } from 'node:fs';

/** Power of Ten rule 3: refuse an absurdly large file instead of processing it. */
const MAX_LINES = 20_000;

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Returns the body of the "## [version]" section (without its heading),
 * or null when there is no such section.
 *
 * @param {string} markdown the whole CHANGELOG.md
 * @param {string} version for example "1.2.0"
 * @returns {string | null}
 */
export function extractSection(markdown, version) {
  const lines = markdown.split('\n');
  if (lines.length > MAX_LINES) {
    throw new Error(`CHANGELOG.md has more than ${String(MAX_LINES)} lines`);
  }

  const heading = `## [${version}]`;
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return null;

  // The section ends at the next "## " heading or at the link definitions
  // ("[1.2.0]: https://...") at the bottom of the file.
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## ') || /^\[[^\]]+\]: /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

/**
 * @param {string | undefined} version
 * @returns {number} the process exit code
 */
function main(version) {
  if (version === undefined || !VERSION_PATTERN.test(version)) {
    console.error('Usage: node scripts/changelog-section.mjs <version>   (for example 1.2.0)');
    return 2;
  }
  const notes = extractSection(readFileSync('CHANGELOG.md', 'utf8'), version);
  if (notes === null || notes === '') {
    console.error(
      `CHANGELOG.md has no notes for ${version}. Add a "## [${version}] - YYYY-MM-DD" section.`,
    );
    return 1;
  }
  process.stdout.write(`${notes}\n`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv[2]);
}
