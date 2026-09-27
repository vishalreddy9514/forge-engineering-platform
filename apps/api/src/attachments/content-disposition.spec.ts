import { attachmentDisposition } from './content-disposition';

describe('attachmentDisposition', () => {
  it('keeps plain names as they are', () => {
    expect(attachmentDisposition('trace.log')).toBe(
      `attachment; filename="trace.log"; filename*=UTF-8''trace.log`,
    );
  });

  it('gives non-ASCII names an ASCII fallback and an exact UTF-8 form', () => {
    expect(attachmentDisposition('résumé (v2).pdf')).toBe(
      `attachment; filename="r_sum_ (v2).pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%28v2%29.pdf`,
    );
  });

  it('cannot be broken out of with quotes or backslashes', () => {
    expect(attachmentDisposition('a"b\\c.txt')).toMatch(/^attachment; filename="a_b_c\.txt";/);
  });
});
