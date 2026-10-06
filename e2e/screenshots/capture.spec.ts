import { fileURLToPath } from 'node:url';

import { expect, type Page, test } from '@playwright/test';

const OUT = fileURLToPath(new URL('../../docs/images', import.meta.url));
// The demo seed's project manager (apps/api/prisma/seed.ts).
const EMAIL = process.env.SCREENSHOT_EMAIL ?? 'priya@forge.local';
const PASSWORD = process.env.SEED_USER_PASSWORD ?? 'forge-demo-password';

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  // Let charts and fonts settle.
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test('dashboard', async ({ page }) => {
  await page.goto('/projects/PAY');
  await shot(page, 'dashboard');
});

test('board', async ({ page }) => {
  await page.goto('/projects/PAY/board');
  await shot(page, 'board');
});

test('issue', async ({ page }) => {
  await page.goto('/projects/PAY/issues/PAY-5');
  await shot(page, 'issue');
});

test('sprints', async ({ page }) => {
  await page.goto('/projects/PAY/sprints');
  await shot(page, 'sprints');
});

test.describe('AI features', () => {
  // Semantic search, related issues and the assistant read the vector index; rebuild it from the
  // seeded data and wait until it answers.
  test.beforeAll(async ({ request }) => {
    const login = await request.post('/api/v1/auth/login', {
      data: { email: 'admin@forge.local', password: PASSWORD },
    });
    expect(login.status(), await login.text()).toBe(200);
    const { accessToken } = (await login.json()) as { accessToken: string };
    const headers = { Authorization: `Bearer ${accessToken}` };
    const reindex = await request.post('/api/v1/admin/search/reindex', { headers });
    expect(reindex.status(), await reindex.text()).toBe(202);

    const projects = await request.get('/api/v1/projects', { headers });
    const { data } = (await projects.json()) as { data: { id: string; key: string }[] };
    const pay = data.find((p) => p.key === 'PAY');
    expect(pay, 'the demo seed has project PAY').toBeDefined();
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `/api/v1/search/semantic?q=reconciliation&projectId=${pay?.id}`,
            { headers },
          );
          if (!res.ok()) return 0;
          return ((await res.json()) as { data: unknown[] }).data.length;
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBeGreaterThan(0);
  });

  test('issue with AI summary', async ({ page }) => {
    await page.goto('/projects/PAY/issues/PAY-1');
    await page.getByRole('button', { name: /Summarise thread|Update summary/ }).click();
    await expect(page.getByText('AI-generated from the thread')).toBeVisible({ timeout: 60_000 });
    await shot(page, 'issue-ai');
  });

  test('draft with AI', async ({ page }) => {
    await page.goto('/projects/PAY/issues');
    await page.getByRole('button', { name: 'New issue' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Draft with AI' }).click();
    const region = dialog.getByRole('region', { name: 'Draft with AI' });
    await region
      .getByLabel('Describe it in your own words')
      .fill(
        'customers on the EU checkout get charged twice when the card provider times out and they press pay again',
      );
    await region.getByRole('button', { name: 'Generate draft' }).click();
    await expect(dialog.getByText(/Draft applied\. Suggested priority/)).toBeVisible({
      timeout: 60_000,
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/ai-draft.png` });
  });

  test('assistant', async ({ page }) => {
    await page.goto('/assistant');
    await page.getByLabel('Search in').selectOption({ label: 'PAY · Payments Platform' });
    await page
      .getByLabel('Your question')
      .fill('Why does the nightly reconciliation job time out, and is anyone fixing it?');
    await page.getByRole('button', { name: 'Ask' }).click();
    await expect(page.getByRole('list', { name: 'Sources' })).toBeVisible({ timeout: 60_000 });
    await shot(page, 'assistant');
  });
});
