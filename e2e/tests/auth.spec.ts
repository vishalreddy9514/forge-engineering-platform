import { expect, test } from '@playwright/test';

import { expectAccessible, newUser, PASSWORD, unique } from './support';

test.describe('authentication', () => {
  test('a new person registers, signs out, and signs back in', async ({ page }) => {
    const email = `e2e-${unique()}@example.test`;

    await page.goto('/register');
    await expectAccessible(page);
    await page.getByLabel('Name').fill('Rae Register');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByLabel('Signed in as')).toHaveText('Rae Register');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByLabel('Signed in as')).toHaveText('Rae Register');
  });

  test('a wrong password is refused without saying which part was wrong', async ({ page }) => {
    const user = await newUser();
    await page.goto('/login');
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill('not the password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    // (Next.js also renders an empty role="alert" route announcer.)
    await expect(
      page.getByRole('alert').filter({ hasText: 'Invalid email or password' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('a protected page sends a visitor to sign in, then back to that page', async ({ page }) => {
    const user = await newUser('Nia Next');
    await page.goto('/projects');
    await expect(page).toHaveURL(/\/login\?next=%2Fprojects$/);
    await expectAccessible(page);

    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByLabel('Signed in as')).toHaveText('Nia Next');
  });

  test('the public pages hydrate without errors and meet WCAG 2.1 AA', async ({ page }) => {
    // These are prerendered: server HTML that React cannot hydrate (e.g. nested headings,
    // which the HTML parser rewrites) fails here as a page error.
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`${page.url()}: ${error.message}`));
    for (const path of ['/login', '/register', '/forgot-password', '/reset-password?token=x']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectAccessible(page);
    }
    expect(errors).toEqual([]);
  });
});
