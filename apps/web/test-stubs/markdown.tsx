// react-markdown is ESM-only; component tests render Markdown as plain text instead.
export function Markdown({ children }: { children: string }) {
  return <div data-testid="markdown">{children}</div>;
}
