// @ts-check
/**
 * Turns Vitest's coverage/coverage-summary.json into a Markdown table.
 * CI appends it to the job summary, so the numbers show up on the run's page:
 *
 *   node scripts/coverage-summary.mjs >> "$GITHUB_STEP_SUMMARY"
 */
import { existsSync, readFileSync } from 'node:fs';

/** @typedef {{ total: number, covered: number, pct: number }} Metric */
/** @typedef {Record<'lines' | 'statements' | 'functions' | 'branches', Metric>} Totals */

/** @type {readonly (keyof Totals)[]} */
const METRICS = ['lines', 'statements', 'functions', 'branches'];

const REPORT = 'coverage/coverage-summary.json';

/**
 * @param {Totals} totals the "total" entry of coverage-summary.json
 * @returns {string}
 */
export function coverageTable(totals) {
  const rows = METRICS.map((name) => {
    const { pct, covered, total } = totals[name];
    return `| ${name} | ${String(pct)}% | ${String(covered)} / ${String(total)} |`;
  });
  return ['### Test coverage', '', '| Metric | Covered | Count |', '| --- | ---: | ---: |', ...rows]
    .join('\n')
    .concat('\n');
}

if (import.meta.main) {
  if (existsSync(REPORT)) {
    /** @type {{ total: Totals }} */
    const summary = JSON.parse(readFileSync(REPORT, 'utf8'));
    process.stdout.write(coverageTable(summary.total));
  } else {
    process.stdout.write('### Test coverage\n\nNo coverage report: the tests did not finish.\n');
  }
}
