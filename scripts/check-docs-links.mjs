#!/usr/bin/env node
/**
 * Checks every relative link and image in the repository's Markdown: the file must exist and,
 * for a link to a heading (`file.md#section`), the heading must too, using GitHub's anchor rules.
 * External URLs are not fetched. `pnpm docs:check`; CI runs it on every pull request.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? '.');
const SKIP = new Set(['node_modules', '.git', '.turbo', '.next', '.venv', 'dist', 'coverage']);

export function markdownFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens, repeats numbered. */
export function anchors(markdown) {
  const seen = new Map();
  const result = new Set();
  for (const line of stripCode(markdown).split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const slug = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/`/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  }
  return result;
}

/** Fenced blocks and inline code are not links. */
function stripCode(markdown) {
  return markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
}

export function links(markdown) {
  const text = stripCode(markdown).replace(/`[^`\n]*`/g, '');
  const found = [];
  for (const m of text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g))
    found.push(m[1]);
  for (const m of text.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm))
    found.push(m[1]);
  for (const m of text.matchAll(/<(?:img|a)\s[^>]*(?:src|href)="([^"]+)"/g)) found.push(m[1]);
  return found;
}

export function check(root) {
  const problems = [];
  const anchorCache = new Map();
  const anchorsOf = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchors(readFileSync(file, 'utf8')));
    return anchorCache.get(file);
  };
  for (const file of markdownFiles(root)) {
    for (const target of links(readFileSync(file, 'utf8'))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:
      const [pathPart, hash] = target.split('#', 2);
      const path = decodeURIComponent(pathPart ?? '');
      const resolved = path ? resolve(dirname(file), path) : file;
      const where = relative(root, file);
      if (!existsSync(resolved)) {
        problems.push(`${where}: ${target} (no such file)`);
      } else if (hash && resolved.endsWith('.md') && !anchorsOf(resolved).has(hash.toLowerCase())) {
        problems.push(`${where}: ${target} (no such heading)`);
      }
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problems = check(ROOT);
  for (const problem of problems) console.error(problem);
  const files = markdownFiles(ROOT).length;
  if (problems.length) {
    console.error(`\n${problems.length} broken link(s) in ${files} Markdown files.`);
    process.exit(1);
  }
  console.log(`All relative links in ${files} Markdown files resolve.`);
}
