import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { anchors, check, links } from './check-docs-links.mjs';

test('anchors follow GitHub: punctuation dropped, spaces hyphenated, repeats numbered', () => {
  const md =
    '# Coverage (NFR-10)\n## End-to-end journeys (Phase 13)\n## `pnpm` & you\n## Notes\n## Notes\n```\n# not a heading\n```';
  assert.deepEqual(
    [...anchors(md)],
    ['coverage-nfr-10', 'end-to-end-journeys-phase-13', 'pnpm--you', 'notes', 'notes-1'],
  );
});

test('links include images, reference links and HTML, but not code', () => {
  const md =
    '![a](img.png) [b](doc.md#x "t")\n[ref]: other.md\n<img src="pic.png">\n`[c](code.md)`\n```\n[d](fenced.md)\n```';
  assert.deepEqual(links(md), ['img.png', 'doc.md#x', 'other.md', 'pic.png']);
});

test('reports missing files and headings, ignores external URLs', () => {
  const root = mkdtempSync(join(tmpdir(), 'docs-links-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'a.md'), '# Title\n## Real section\n');
  writeFileSync(
    join(root, 'README.md'),
    [
      '[ok](docs/a.md#real-section)',
      '[self](#readme)',
      '[gone](docs/missing.md)',
      '[bad anchor](docs/a.md#no-such)',
      '![missing image](docs/images/x.png)',
      '[web](https://example.com/nothing)',
      '# README',
    ].join('\n'),
  );
  assert.deepEqual(check(root), [
    'README.md: docs/missing.md (no such file)',
    'README.md: docs/a.md#no-such (no such heading)',
    'README.md: docs/images/x.png (no such file)',
  ]);
});
