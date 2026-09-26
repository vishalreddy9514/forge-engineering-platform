import { escapeHtml, renderIssueAssigned, renderPasswordReset } from './templates';

describe('email templates', () => {
  const job = {
    to: 'a@b.co',
    displayName: '<script>alert(1)</script>',
    resetUrl: 'http://localhost:3000/reset-password?token=abc&x=1',
    expiresInMinutes: 30,
  };

  it('escapes user-controlled values in HTML', () => {
    const { html } = renderPasswordReset(job);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('href="http://localhost:3000/reset-password?token=abc&amp;x=1"');
  });

  it('includes the link and expiry in the plain-text part', () => {
    const { text } = renderPasswordReset(job);
    expect(text).toContain(job.resetUrl);
    expect(text).toContain('30 minutes');
  });

  it('escapes all HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('renders the assignment email with escaped, user-written titles', () => {
    const email = renderIssueAssigned({
      to: 'a@b.co',
      displayName: 'Sam',
      actorName: 'Priya <b>',
      issueKey: 'PAY-3',
      issueTitle: 'Fix <img src=x onerror=alert(1)>',
      issueUrl: 'http://localhost:3000/projects/PAY/issues/PAY-3',
    });
    expect(email.subject).toBe('[PAY-3] Fix <img src=x onerror=alert(1)>');
    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('Priya &lt;b&gt;');
    expect(email.text).toContain('http://localhost:3000/projects/PAY/issues/PAY-3');
  });
});
