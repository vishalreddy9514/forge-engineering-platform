/**
 * `Content-Disposition: attachment` with the original name (RFC 6266). The quoted `filename`
 * is an ASCII fallback; `filename*` carries the exact UTF-8 name for browsers that support it.
 * Always `attachment`: files are downloaded, never rendered as a page.
 */
export function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
