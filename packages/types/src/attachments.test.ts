import {
  attachmentContentType,
  CreateAttachmentRequest,
  formatBytes,
  MAX_ATTACHMENT_BYTES,
  sanitizeFileName,
} from './attachments';

describe('attachmentContentType', () => {
  it('accepts allowed declared types, ignoring parameters and case', () => {
    expect(attachmentContentType({ name: 'a.png', type: 'image/png' })).toBe('image/png');
    expect(attachmentContentType({ name: 'a.txt', type: 'Text/Plain; charset=utf-8' })).toBe(
      'text/plain',
    );
  });

  it('falls back to the extension when the browser declares nothing or something odd', () => {
    expect(attachmentContentType({ name: 'NOTES.MD', type: '' })).toBe('text/markdown');
    expect(attachmentContentType({ name: 'server.log', type: 'text/x-log' })).toBe('text/plain');
    expect(attachmentContentType({ name: 'export.csv', type: 'application/vnd.ms-excel' })).toBe(
      'text/csv',
    );
    expect(attachmentContentType({ name: 'server.log', type: 'application/octet-stream' })).toBe(
      'text/plain',
    );
  });

  it('rejects script-capable and unknown types, even with an allowed extension', () => {
    expect(attachmentContentType({ name: 'x.svg', type: 'image/svg+xml' })).toBeNull();
    expect(attachmentContentType({ name: 'x.png', type: 'text/html' })).toBeNull();
    expect(attachmentContentType({ name: 'x.txt', type: 'application/xhtml+xml' })).toBeNull();
    expect(attachmentContentType({ name: 'x.json', type: 'text/javascript' })).toBeNull();
    expect(attachmentContentType({ name: 'setup.exe', type: '' })).toBeNull();
  });
});

describe('sanitizeFileName', () => {
  it('drops paths, control characters, quotes and leading dots', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\sam\\report.pdf')).toBe('report.pdf');
    expect(sanitizeFileName('bad"\r\nname.txt')).toBe('badname.txt');
    expect(sanitizeFileName('.env')).toBe('env');
    expect(sanitizeFileName('  lots   of   space.png ')).toBe('lots of space.png');
  });

  it('caps the length', () => {
    expect(sanitizeFileName(`${'a'.repeat(300)}.txt`)).toHaveLength(255);
  });
});

describe('CreateAttachmentRequest', () => {
  const valid = { fileName: 'trace.log', contentType: 'text/plain', sizeBytes: 1200 };

  it('accepts a valid request and cleans the name', () => {
    expect(CreateAttachmentRequest.parse({ ...valid, fileName: '/tmp/trace.log' })).toEqual(valid);
  });

  it('enforces the size limit and the type allow-list', () => {
    expect(CreateAttachmentRequest.safeParse({ ...valid, sizeBytes: 0 }).success).toBe(false);
    expect(
      CreateAttachmentRequest.safeParse({ ...valid, sizeBytes: MAX_ATTACHMENT_BYTES + 1 }).success,
    ).toBe(false);
    expect(CreateAttachmentRequest.safeParse({ ...valid, contentType: 'text/html' }).success).toBe(
      false,
    );
    expect(CreateAttachmentRequest.safeParse({ ...valid, fileName: '../' }).success).toBe(false);
  });
});

describe('formatBytes', () => {
  it('uses readable units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(200 * 1024)).toBe('200 KB');
    expect(formatBytes(3.25 * 1024 * 1024)).toBe('3.3 MB');
  });
});
