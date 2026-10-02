import { expect, test } from '@playwright/test';

import { Api, expectAccessible, newProject, newUser, signIn, unique } from './support';

// The AI service runs with its deterministic fake provider: these journeys test the wiring
// (streaming, indexing through the outbox and worker, retrieval, citations), not model quality.
test.describe('AI assistance', () => {
  test('rough notes become an issue draft, which the person reviews and creates', async ({
    page,
  }) => {
    const manager = await newUser('Ada Author');
    const project = await newProject(manager);
    await signIn(page, manager);
    await page.goto(`/projects/${project.key}/issues`);

    await page.getByRole('button', { name: 'New issue' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Draft with AI' }).click();
    const draft = dialog.getByRole('region', { name: 'Draft with AI' });
    await draft
      .getByLabel('Describe it in your own words')
      .fill('customers get charged twice when the payment webhook is retried after a timeout');
    await draft.getByRole('button', { name: 'Generate draft' }).click();

    await expect(draft.getByText(/Draft applied\. Suggested priority/)).toBeVisible();
    const title = dialog.getByLabel('Title');
    await expect(title).not.toHaveValue('');
    await expectAccessible(page);
    const drafted = await title.inputValue();

    // Nothing was created until the person presses Create.
    await dialog.getByRole('button', { name: 'Create issue' }).click();
    await expect(page.getByRole('heading', { name: drafted })).toBeVisible();
  });

  test('the assistant answers from the project and cites the issue it used', async ({ page }) => {
    const manager = await newUser('Cy Curious');
    const project = await newProject(manager, [], 'Ledger');
    const api = await Api.as(manager);
    const term = `ledger${unique()}`;
    const issue = await api.post<{ key: string }>(`projects/${project.id}/issues`, {
      title: `Nightly ${term} reconciliation drops refunds`,
      description: `The ${term} job skips refunds issued after 23:00 UTC because it filters by the wrong date column.`,
    });

    // Indexed in the background: issue write → outbox → worker → AI service.
    await expect
      .poll(
        async () =>
          (
            await api.get<{ data: { title: string }[] }>(
              `search/semantic?q=${term}&projectId=${project.id}`,
            )
          ).data.length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    await api.dispose();

    await signIn(page, manager);
    await page.goto('/assistant');
    await expectAccessible(page);
    await page.getByLabel('Search in').selectOption({ label: `${project.key} · Ledger` });
    await page
      .getByLabel('Your question')
      .fill(`Why does the ${term} reconciliation drop refunds?`);
    await page.getByRole('button', { name: 'Ask' }).click();

    const sources = page.getByRole('list', { name: 'Sources' });
    await expect(sources).toBeVisible({ timeout: 20_000 });
    const cited = sources.getByRole('link', { name: new RegExp(issue.key) });
    await expect(cited).toBeVisible();
    await expectAccessible(page);
    await cited.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${project.key}/issues/${issue.key}`));
  });
});
