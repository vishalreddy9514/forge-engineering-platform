/// <reference lib="dom" />
// (Code passed to page.evaluate / addInitScript runs in the browser.)

import { expect, type Page, test } from '@playwright/test';

import { Api, newProject, newUser, signIn } from './support';

/** Records every Content Security Policy violation the page reports, from its first script. */
async function recordViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.effectiveDirective} blocked ${event.blockedURI || 'inline'}`);
    });
  });
  return () =>
    page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

// The pages run under a nonce-based CSP: anything the app itself needs must still work, and
// script the page did not ship must not run.
test('the app works under its Content Security Policy, which refuses injected script', async ({
  page,
}) => {
  const manager = await newUser('Cass Policy');
  const project = await newProject(manager, [], 'Policy');
  const api = await Api.as(manager);
  // A description written to attack whoever reads it: raw HTML and a script link.
  const issue = await api.post<{ key: string }>(`projects/${project.id}/issues`, {
    title: 'Checkout ignores the CSP report',
    priority: 'HIGH',
    description: [
      'Steps: <img src="data:," onerror="window.__fromMarkdown = true">',
      '<script>window.__fromMarkdown = true</script>',
      '[open the receipt](javascript:window.__fromMarkdown=true)',
    ].join('\n\n'),
  });
  await api.dispose();
  const violations = await recordViolations(page);
  await signIn(page, manager);

  const pages = [
    '/',
    `/projects/${project.key}`,
    `/projects/${project.key}/board`,
    `/projects/${project.key}/sprints`,
    '/search?q=checkout',
    '/notifications',
    `/projects/${project.key}/issues/${issue.key}`,
  ];
  for (const path of pages) {
    await test.step(path, async () => {
      const response = await page.goto(path);
      const policy = response?.headers()['content-security-policy'] ?? '';
      expect(policy).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic'/);
      expect(response?.headers()['x-frame-options']).toBe('DENY');
      expect(response?.headers()['x-content-type-options']).toBe('nosniff');
      await expect(page.getByRole('main')).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await violations()).toEqual([]);
    });
  }

  await test.step('markup in a description is shown as text, never run', async () => {
    // The issue page is the last one visited above.
    await expect(page.getByText('<img src="data:," onerror=', { exact: false })).toBeVisible();
    await expect(page.locator('main img[onerror], main script')).toHaveCount(0);
    const link = page.getByRole('link', { name: 'open the receipt' });
    await expect(link).not.toHaveAttribute('href', /^javascript:/i);
    expect(
      await page.evaluate(() => (window as unknown as { __fromMarkdown?: boolean }).__fromMarkdown),
    ).toBeUndefined();
  });

  await test.step('an upload to object storage is allowed', async () => {
    await page.locator('#attachment-input').setInputFiles({
      name: 'policy.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('connect-src allows the storage origin\n'),
    });
    await expect(page.getByRole('button', { name: 'Download policy.txt' })).toBeVisible();
    expect(await violations()).toEqual([]);
  });

  // What a sanitiser bypass would inject: markup with an inline handler. ('strict-dynamic'
  // deliberately trusts scripts that the app's own scripts create, so that is not the test.)
  await test.step('injected markup cannot run script', async () => {
    await page.evaluate(() => {
      const div = document.createElement('div');
      div.innerHTML = '<img src="data:," onerror="window.__injected = true" alt="">';
      document.body.append(div);
    });
    await expect.poll(violations).toContain('script-src-attr blocked inline');
    expect(
      await page.evaluate(() => (window as unknown as { __injected?: boolean }).__injected),
    ).toBeUndefined();
  });
});
