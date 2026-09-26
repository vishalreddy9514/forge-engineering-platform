/**
 * Suggests a project key from its name, the way Jira does: initials of the words, or the first
 * letters of a single word. "Payments Platform" → "PP", "Identity & Access" → "IA",
 * "Checkout" → "CHECK". Always a valid key (2–10 characters, starting with a letter), or ''.
 */
export function suggestProjectKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const firstLetter = words.findIndex((w) => /^[A-Z]/.test(w));
  if (firstLetter === -1) return '';
  const usable = words.slice(firstLetter);

  const initials = usable.map((w) => w[0]).join('');
  const key = usable.length > 1 && initials.length >= 2 ? initials : (usable[0] ?? '').slice(0, 5);
  return key.length >= 2 ? key.slice(0, 10) : '';
}
