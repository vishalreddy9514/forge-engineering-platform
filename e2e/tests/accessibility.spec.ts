import { expect, test } from '@playwright/test';

import { Api, expectAccessible, newProject, newUser, signIn } from './support';

// NFR-13: WCAG 2.1 AA on core pages. The journeys check the pages they pass through; this
// covers the rest, with real content on each so the rules have something to inspect.
test('the remaining core pages meet WCAG 2.1 AA', async ({ page }) => {
  const [manager, developer] = await Promise.all([newUser('Ari Admin'), newUser('Bo Builder')]);
  const project = await newProject(manager, [[developer, 'DEVELOPER']], 'Accessibility');
  const api = await Api.as(manager);
  await api.post(`projects/${project.id}/labels`, { name: 'payments', color: '#1d76db' });
  await api.post(`projects/${project.id}/issues`, {
    title: 'Keyboard users cannot reach the refund button',
    priority: 'HIGH',
    type: 'BUG',
  });
  await api.dispose();
  await signIn(page, manager);

  const pages: [string, string][] = [
    ['/search?q=refund', 'Search'],
    ['/notifications', 'Notifications'],
    [`/projects/${project.key}/members`, 'Members'],
    [`/projects/${project.key}/labels`, 'Labels'],
    [`/projects/${project.key}/settings`, 'Settings'],
    [`/projects/${project.key}/documents`, 'Documents'],
    [`/projects/${project.key}/code`, 'Code'],
  ];
  for (const [path, name] of pages) {
    await test.step(name, async () => {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      // Let client data arrive before inspecting.
      await page.waitForLoadState('networkidle');
      await expectAccessible(page);
    });
  }
});
