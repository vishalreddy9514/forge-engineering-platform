import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import { Api, newProject, newUser, signIn } from './support';

// Files never pass through the API: the browser uploads to object storage with a pre-signed
// URL and downloads the same way. This proves those URLs are reachable from the browser.
test('a file attached to an issue uploads to object storage and downloads intact', async ({
  page,
}) => {
  const manager = await newUser('Fay Files');
  const project = await newProject(manager);
  const api = await Api.as(manager);
  const issue = await api.post<{ key: string }>(`projects/${project.id}/issues`, {
    title: 'Attach the failing payload',
  });
  await api.dispose();

  await signIn(page, manager);
  await page.goto(`/projects/${project.key}/issues/${issue.key}`);
  const content = `{"id":"evt_42","type":"payment_intent.succeeded"}\n`;
  // The input is hidden behind the "Attach files" button; set its files directly.
  await page.locator('#attachment-input').setInputFiles({
    name: 'payload.json',
    mimeType: 'application/json',
    buffer: Buffer.from(content),
  });
  // Listed once the upload is confirmed (an error message would also name the file).
  await expect(page.getByRole('button', { name: 'Download payload.json' })).toBeVisible();

  // The API answers with a short-lived pre-signed URL that serves the file as an attachment.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download payload.json' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('payload.json');
  const saved = await file.path();
  expect(readFileSync(saved, 'utf8')).toBe(content);
});
