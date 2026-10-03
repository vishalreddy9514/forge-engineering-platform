import { expect, test } from '@playwright/test';

import { expectAccessible, newUser, projectKey, signIn } from './support';

test.describe('projects and issues', () => {
  test('a manager creates a project, files an issue, discusses it and moves it on the board', async ({
    page,
  }) => {
    const manager = await newUser('Mona Manager');
    await signIn(page, manager);
    const key = projectKey();

    // Project
    await page.goto('/projects');
    await expectAccessible(page);
    await page.getByRole('link', { name: 'New project' }).click();
    await page.getByLabel('Project name').fill('Checkout revamp');
    await page.getByLabel('Key').fill(key);
    await expectAccessible(page);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${key}$`));
    await expect(page.getByRole('heading', { name: 'Checkout revamp' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expectAccessible(page);

    // Issue
    await page.getByRole('link', { name: 'Issues' }).click();
    await page.getByRole('button', { name: 'New issue' }).click();
    const dialog = page.getByRole('dialog', { name: /New issue in Checkout revamp/ });
    await dialog.getByLabel('Title').fill('Card payments time out under load');
    await expectAccessible(page);
    await dialog.getByRole('button', { name: 'Create issue' }).click();
    // Creating an issue opens it.
    await expect(page).toHaveURL(new RegExp(`/projects/${key}/issues/${key}-1$`));
    await expect(
      page.getByRole('heading', { name: 'Card payments time out under load' }),
    ).toBeVisible();

    // It is listed, and the list opens it again
    await page.getByRole('link', { name: 'Issues' }).first().click();
    const issueLink = page.getByRole('link', { name: 'Card payments time out under load' });
    await expect(issueLink).toBeVisible();
    await expectAccessible(page);
    await issueLink.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${key}/issues/${key}-1$`));

    // Discussion and workflow on the issue page
    await page.getByLabel('Add a comment').fill('Reproduced with **200** concurrent checkouts.');
    await page.getByRole('button', { name: 'Comment' }).click();
    await expect(page.getByText('Reproduced with')).toBeVisible();
    await page.getByLabel('Status').selectOption({ label: 'To do' });
    await expect(page.getByLabel('Status')).toHaveValue('TODO');
    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.getByText('changed the status from Backlog to To do')).toBeVisible();
    await expectAccessible(page);

    // Board: the card is in "To do"; move it to "In progress" without dragging
    await page.getByRole('link', { name: 'Board' }).click();
    const todo = page.getByRole('region', { name: 'To do' });
    await expect(
      todo.getByRole('link', { name: 'Card payments time out under load' }),
    ).toBeVisible();
    await expectAccessible(page);
    await todo.getByLabel(`Move ${key}-1`).selectOption({ label: 'In progress' });
    const inProgress = page.getByRole('region', { name: 'In progress' });
    await expect(
      inProgress.getByRole('link', { name: 'Card payments time out under load' }),
    ).toBeVisible();

    // It survives a reload: the move was saved, not just drawn
    await page.reload();
    await expect(
      page
        .getByRole('region', { name: 'In progress' })
        .getByRole('link', { name: 'Card payments time out under load' }),
    ).toBeVisible();
  });
});
