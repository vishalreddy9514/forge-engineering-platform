import { selectReviewFiles, type GithubPullFile } from './review-files';

const file = (
  filename: string,
  patch: string | undefined = '@@ -1 +1 @@\n+x',
  status = 'modified',
): GithubPullFile => ({
  filename,
  status,
  additions: 1,
  deletions: 0,
  patch,
});

describe('selectReviewFiles', () => {
  it('skips what a reviewer would not read, and says why', () => {
    const { files, omitted } = selectReviewFiles([
      file('src/app.ts'),
      file('pnpm-lock.yaml'),
      file('apps/api/src/generated/prisma/client.ts'),
      file('web/dist/bundle.min.js'),
      file('vendor/lib/x.go'),
      { ...file('assets/logo.png'), patch: undefined },
      { ...file('src/old.ts'), status: 'removed' },
      file('src/same.ts', '@@', 'unchanged'),
    ]);

    expect(files.map((f) => f.path)).toEqual(['src/app.ts']);
    expect(omitted).toEqual([
      { path: 'pnpm-lock.yaml', reason: 'lockfile' },
      { path: 'apps/api/src/generated/prisma/client.ts', reason: 'generated' },
      { path: 'web/dist/bundle.min.js', reason: 'generated' },
      { path: 'vendor/lib/x.go', reason: 'vendored' },
      { path: 'assets/logo.png', reason: 'binary or too large to diff' },
      { path: 'src/old.ts', reason: 'deleted' },
      { path: 'src/same.ts', reason: 'unchanged' },
    ]);
  });

  it('reviews code before docs and config when the budget runs out', () => {
    const patch = (tokens: number) => '+'.repeat(tokens * 4);
    const { files, omitted } = selectReviewFiles(
      [file('README.md', patch(40)), file('src/a.ts', patch(40)), file('src/b.ts', patch(40))],
      100,
    );
    expect(files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(omitted).toEqual([{ path: 'README.md', reason: 'review budget' }]);
  });

  it('skips a single huge diff instead of spending the whole budget on it', () => {
    const { files, omitted } = selectReviewFiles([
      file('src/huge.ts', '+'.repeat(15_001 * 4)),
      file('src/small.ts'),
    ]);
    expect(files.map((f) => f.path)).toEqual(['src/small.ts']);
    expect(omitted).toEqual([{ path: 'src/huge.ts', reason: 'diff too large' }]);
  });

  it('caps the number of files', () => {
    const many = Array.from({ length: 5 }, (_, i) => file(`src/f${String(i)}.ts`));
    const { files, omitted } = selectReviewFiles(many, 60_000, 3);
    expect(files).toHaveLength(3);
    expect(omitted.map((o) => o.reason)).toEqual(['file limit', 'file limit']);
  });

  it('keeps the fields the AI service needs', () => {
    expect(selectReviewFiles([file('src/a.ts')]).files[0]).toEqual({
      path: 'src/a.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: '@@ -1 +1 @@\n+x',
    });
  });
});
