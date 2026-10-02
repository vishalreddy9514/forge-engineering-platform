import type { ReviewInput } from './ai.wire';

/** A changed file as GitHub's "list pull request files" endpoint returns it. */
export interface GithubPullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Absent for binary files and for diffs GitHub considers too large to show. */
  patch?: string;
}

/** Whole-review input cap (architecture §7.3): about 60k tokens of diff. */
export const REVIEW_TOKEN_BUDGET = 60_000;
/** One file larger than this is skipped rather than allowed to use most of the budget. */
export const FILE_TOKEN_LIMIT = 15_000;
export const MAX_REVIEW_FILES = 60;
const CHARS_PER_TOKEN = 4;

const LOCKFILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'uv.lock',
  'poetry.lock',
  'Pipfile.lock',
  'Cargo.lock',
  'go.sum',
  'Gemfile.lock',
  'composer.lock',
  'mix.lock',
]);
const GENERATED = [
  /(^|\/)(dist|build|out|coverage|\.next)\//,
  /(^|\/)(generated|__generated__)\//,
  /\.min\.(js|css)$/,
  /\.map$/,
  /\.snap$/,
  /\.pb\.(go|ts|py)$/,
  /_pb2\.py$/,
];
const VENDORED = /(^|\/)(vendor|node_modules|third_party)\//;
/** Reviewed last when the budget is tight: they rarely hide bugs. */
const LOW_PRIORITY = /\.(md|mdx|txt|rst|json|ya?ml|toml|ini|cfg|lock|svg|csv)$/i;

const STATUSES = new Set(['added', 'modified', 'renamed', 'copied', 'changed']);

export interface ReviewSelection {
  files: ReviewInput['files'];
  omitted: ReviewInput['omittedFiles'];
}

const tokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

function skipReason(file: GithubPullFile): string | null {
  const name = file.filename.split('/').pop() ?? file.filename;
  if (file.status === 'removed') return 'deleted';
  if (!STATUSES.has(file.status)) return 'unchanged';
  if (LOCKFILES.has(name)) return 'lockfile';
  if (VENDORED.test(file.filename)) return 'vendored';
  if (GENERATED.some((pattern) => pattern.test(file.filename))) return 'generated';
  if (!file.patch) return 'binary or too large to diff';
  if (tokens(file.patch) > FILE_TOKEN_LIMIT) return 'diff too large';
  return null;
}

/**
 * Chooses what to send for review (FR-9.1): skips lockfiles, generated, vendored, deleted and
 * binary files, then fills the token budget, code before documentation and configuration. Every
 * skipped file is reported with its reason, so the review says what it did not look at.
 */
export function selectReviewFiles(
  files: GithubPullFile[],
  budget = REVIEW_TOKEN_BUDGET,
  maxFiles = MAX_REVIEW_FILES,
): ReviewSelection {
  const omitted: ReviewSelection['omitted'] = [];
  const candidates: GithubPullFile[] = [];
  for (const file of files) {
    const reason = skipReason(file);
    if (reason) omitted.push({ path: file.filename, reason });
    else candidates.push(file);
  }
  // Stable: code first, then everything else, each in GitHub's (alphabetical) order.
  candidates.sort(
    (a, b) => Number(LOW_PRIORITY.test(a.filename)) - Number(LOW_PRIORITY.test(b.filename)),
  );

  const selected: ReviewSelection['files'] = [];
  let used = 0;
  for (const file of candidates) {
    const cost = tokens(file.patch ?? '');
    if (selected.length >= maxFiles) {
      omitted.push({ path: file.filename, reason: 'file limit' });
    } else if (used + cost > budget) {
      omitted.push({ path: file.filename, reason: 'review budget' });
    } else {
      used += cost;
      selected.push({
        path: file.filename,
        status: file.status as ReviewInput['files'][number]['status'],
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch ?? '',
      });
    }
  }
  return { files: selected, omitted };
}
