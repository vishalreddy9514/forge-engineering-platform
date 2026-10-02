import { expect, test } from '@playwright/test';

import { Api, expectAccessible, newProject, newUser, signIn } from './support';

interface Issue {
  id: string;
  key: string;
  version: number;
}

test.describe('sprints', () => {
  test('a manager plans a sprint, runs it, and completes it; velocity and the dashboard follow', async ({
    page,
  }) => {
    const manager = await newUser('Pia Planner');
    const project = await newProject(manager, [], 'Sprint project');
    const api = await Api.as(manager);
    const issue = (title: string, storyPoints: number) =>
      api.post<Issue>(`projects/${project.id}/issues`, { title, storyPoints, status: 'TODO' });
    const done = await issue('Retry failed webhooks', 3);
    const open = await issue('Refund partial captures', 5);

    await signIn(page, manager);
    await page.goto(`/projects/${project.key}/sprints`);
    await expectAccessible(page);

    // Plan
    await page.getByRole('button', { name: 'New sprint' }).click();
    const plan = page.getByRole('dialog', { name: 'Plan a sprint' });
    await plan.getByLabel('Name').fill('Sprint 1');
    await expectAccessible(page);
    await plan.getByRole('button', { name: 'Create sprint' }).click();
    const planned = page.getByRole('region', { name: 'Sprint 1' });
    await expect(planned).toBeVisible();

    const backlog = page.getByRole('list', { name: 'Backlog' });
    for (const i of [done, open]) {
      await backlog.getByLabel(`Add ${i.key} to a sprint`).selectOption({ label: 'Sprint 1' });
      await expect(page.getByRole('list', { name: 'Issues in Sprint 1' })).toContainText(i.key);
    }

    // Run: start it, finish one issue (as a developer would, on the issue page)
    await planned.getByRole('button', { name: 'Start sprint' }).click();
    const active = page.getByRole('region', { name: 'Active sprint' });
    await expect(active).toContainText('Sprint 1');
    await page.goto(`/projects/${project.key}/issues/${done.key}`);
    await page.getByLabel('Status').selectOption({ label: 'In progress' });
    await expect(page.getByLabel('Status')).toHaveValue('IN_PROGRESS');
    await page.getByLabel('Status').selectOption({ label: 'Done' });
    await expect(page.getByLabel('Status')).toHaveValue('DONE');

    // The dashboard counts it: 3 of 8 points done
    await page.goto(`/projects/${project.key}`);
    await expect(page.getByRole('meter', { name: 'Sprint points done' })).toHaveAttribute(
      'aria-valuetext',
      '3 of 8 points done',
    );
    await expect(page.getByText('Burndown')).toBeVisible();
    await expectAccessible(page);

    // Complete: the unfinished issue returns to the backlog, and velocity records 3 of 8
    await page.goto(`/projects/${project.key}/sprints`);
    await page.getByRole('button', { name: 'Complete sprint' }).click();
    const complete = page.getByRole('dialog', { name: 'Complete Sprint 1' });
    await expect(complete).toContainText('1 issue is not done yet.');
    await expect(complete.getByLabel('Move unfinished issues to')).toHaveValue('backlog');
    await expectAccessible(page);
    await complete.getByRole('button', { name: 'Complete sprint' }).click();
    await expect(complete).toBeHidden();

    await expect(page.getByRole('list', { name: 'Backlog' })).toContainText(open.key);
    await expect(
      page.getByRole('img', { name: 'Sprint 1: 3 of 8 points completed' }),
    ).toBeVisible();
    await expectAccessible(page);
    await api.dispose();
  });
});
