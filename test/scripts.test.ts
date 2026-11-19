import { describe, expect, it } from 'vitest';
import { extractSection } from '../scripts/changelog-section.mjs';
import { coverageTable } from '../scripts/coverage-summary.mjs';

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Something new.

## [1.1.0] - 2026-12-01

### Fixed

- A bug.

## [1.0.0] - 2026-11-20

### Added

- First release.

[Unreleased]: https://github.com/example/repo/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/example/repo/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/example/repo/releases/tag/v1.0.0
`;

describe('scripts/changelog-section.mjs', () => {
  it('returns the notes of a version, up to the next heading', () => {
    expect(extractSection(CHANGELOG, '1.1.0')).toBe('### Fixed\n\n- A bug.');
  });

  it('stops the last section at the link definitions', () => {
    expect(extractSection(CHANGELOG, '1.0.0')).toBe('### Added\n\n- First release.');
  });

  it('returns null for a version without a section', () => {
    expect(extractSection(CHANGELOG, '2.0.0')).toBeNull();
  });

  it('does not mistake a longer version for the one asked for', () => {
    const markdown = '## [1.0.0-beta.1] - 2026-11-01\n\n- Beta.\n';
    expect(extractSection(markdown, '1.0.0')).toBeNull();
  });

  it('refuses absurdly large files (Power of Ten rule 3)', () => {
    expect(() => extractSection('\n'.repeat(20_001), '1.0.0')).toThrow(/more than 20000 lines/);
  });
});

describe('scripts/coverage-summary.mjs', () => {
  it('renders a Markdown table of the coverage totals', () => {
    const metric = { total: 200, covered: 190, pct: 95 };
    const table = coverageTable({
      lines: metric,
      statements: metric,
      functions: { total: 40, covered: 40, pct: 100 },
      branches: { total: 60, covered: 51, pct: 85 },
    });

    expect(table).toContain('| Metric | Covered | Count |');
    expect(table).toContain('| lines | 95% | 190 / 200 |');
    expect(table).toContain('| functions | 100% | 40 / 40 |');
    expect(table).toContain('| branches | 85% | 51 / 60 |');
  });
});
