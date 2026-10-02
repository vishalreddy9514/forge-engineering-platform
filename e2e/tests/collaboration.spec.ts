import { expect, test } from '@playwright/test';

import { Api, expectAccessible, newProject, newUser, signIn } from './support';

test.describe('working together', () => {
  test('assigning an issue notifies the developer, who follows it to the issue', async ({
    page,
    browser,
  }) => {
    const [manager, developer] = await Promise.all([newUser('Max Manager'), newUser('Dee Dev')]);
    const project = await newProject(manager, [[developer, 'DEVELOPER']]);
    const api = await Api.as(manager);
    const issue = await api.post<{ key: string }>(`projects/${project.id}/issues`, {
      title: 'Settlement report is off by one day',
    });
    await api.dispose();

    await signIn(page, manager);
    await page.goto(`/projects/${project.key}/issues/${issue.key}`);
    await page.getByLabel('Assignee').selectOption({ label: 'Dee Dev' });
    await expect(page.getByRole('tab', { name: 'History' })).toBeVisible();
    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.getByText('changed the assignee from none to Dee Dev')).toBeVisible();

    // The developer, in their own browser
    const devContext = await browser.newContext();
    const devPage = await devContext.newPage();
    await signIn(devPage, developer);
    await devPage.goto('/projects');
    // Delivered in the background (outbox → worker), so allow it a moment.
    const bell = devPage.getByRole('link', { name: /^Notifications/ });
    await expect(async () => {
      await devPage.reload();
      await expect(bell).toHaveAccessibleName('Notifications, 1 unread', { timeout: 1_000 });
    }).toPass({ timeout: 30_000 });

    await bell.click();
    await expectAccessible(devPage);
    await devPage
      .getByRole('button', { name: new RegExp(`Max Manager assigned you ${issue.key}`) })
      .click();
    await expect(devPage).toHaveURL(new RegExp(`/projects/${project.key}/issues/${issue.key}$`));
    await expect(devPage.getByLabel('Assignee')).toHaveValue(developer.id);
    await devContext.close();
  });

  test('a viewer can read but not change anything, and an outsider cannot see the project', async ({
    page,
    browser,
  }) => {
    const [manager, viewer, outsider] = await Promise.all([
      newUser('Ola Owner'),
      newUser('Vic Viewer'),
      newUser('Otto Outsider'),
    ]);
    const project = await newProject(manager, [[viewer, 'VIEWER']]);
    const api = await Api.as(manager);
    const issue = await api.post<{ key: string }>(`projects/${project.id}/issues`, {
      title: 'Read-only check',
    });
    await api.dispose();

    await signIn(page, viewer);
    await page.goto(`/projects/${project.key}/issues`);
    await expect(page.getByRole('link', { name: 'Read-only check' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New issue' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Read-only check' }).click();
    await expect(page.getByLabel('Status')).toBeDisabled();
    await expect(page.getByLabel('Add a comment')).toHaveCount(0);
    await page.goto(`/projects/${project.key}/board`);
    await expect(page.getByLabel(`Move ${issue.key}`)).toHaveCount(0);

    const outsiderContext = await browser.newContext();
    const outsiderPage = await outsiderContext.newPage();
    await signIn(outsiderPage, outsider);
    await outsiderPage.goto(`/projects/${project.key}/issues/${issue.key}`);
    await expect(outsiderPage.getByRole('heading', { name: 'Project not found' })).toBeVisible();
    await expect(outsiderPage.getByText('Read-only check')).toHaveCount(0);
    await outsiderContext.close();
  });
});
