import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { AttachmentCleanup } from '../../src/attachments/attachment-cleanup.service';
import { StorageService } from '../../src/infrastructure/storage/storage.service';
import { uid } from './helpers';
import { createTestApp, type SignedInUser, signIn, type TestApp } from './test-app';

interface Upload {
  attachment: { id: string; status: string };
  upload: { url: string; method: 'PUT'; headers: Record<string, string> };
}

describe('attachments (HTTP, real Postgres + Redis + S3-compatible storage)', () => {
  let t: TestApp;
  let storage: StorageService;

  beforeAll(async () => {
    t = await createTestApp();
    storage = t.app.get(StorageService);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.redis.flushdb();
  });

  interface World {
    project: { id: string };
    issueId: string;
    pm: SignedInUser;
    dev: SignedInUser;
    dev2: SignedInUser;
    viewer: SignedInUser;
    outsider: SignedInUser;
  }

  async function world(): Promise<World> {
    const [pm, dev, dev2, viewer, outsider] = await Promise.all([
      signIn(t, { displayName: 'Pat' }),
      signIn(t, { displayName: 'Dev' }),
      signIn(t, { displayName: 'Dee' }),
      signIn(t, { displayName: 'Vic' }),
      signIn(t, { displayName: 'Out' }),
    ]);
    const key = `A${uid().toUpperCase()}`.slice(0, 8);
    const project = (
      await t.http.post('/api/v1/projects').set(pm.auth).send({ key, name: 'Files' }).expect(201)
    ).body as { id: string };
    for (const [user, role] of [
      [dev, 'DEVELOPER'],
      [dev2, 'DEVELOPER'],
      [viewer, 'VIEWER'],
    ] as const) {
      await t.http
        .post(`/api/v1/projects/${project.id}/members`)
        .set(pm.auth)
        .send({ email: user.email, role })
        .expect(201);
    }
    const issue = await t.http
      .post(`/api/v1/projects/${project.id}/issues`)
      .set(pm.auth)
      .send({ title: 'Has files' })
      .expect(201);
    return { project, issueId: issue.body.id as string, pm, dev, dev2, viewer, outsider };
  }

  const TEXT = 'stack trace: NullPointerException at line 42\n';

  function requestUpload(w: World, user: SignedInUser, body: Record<string, unknown> = {}) {
    return t.http
      .post(`/api/v1/issues/${w.issueId}/attachments`)
      .set(user.auth)
      .send({ fileName: 'trace.log', contentType: 'text/plain', sizeBytes: TEXT.length, ...body });
  }

  /** What the browser does: PUT the bytes straight to storage with the signed headers. */
  function put(upload: Upload, body: string, headers = upload.upload.headers) {
    return fetch(upload.upload.url, { method: 'PUT', body, headers });
  }

  async function uploaded(w: World, user: SignedInUser = w.dev): Promise<string> {
    const res = await requestUpload(w, user).expect(201);
    const upload = res.body as Upload;
    expect((await put(upload, TEXT)).status).toBe(200);
    await t.http
      .post(`/api/v1/attachments/${upload.attachment.id}/complete`)
      .set(user.auth)
      .expect(200);
    return upload.attachment.id;
  }

  it('uploads straight to storage, then becomes visible once completed', async () => {
    const w = await world();
    const res = await requestUpload(w, w.dev, { fileName: '../../logs/trace.log' }).expect(201);
    const upload = res.body as Upload;
    expect(upload.attachment).toMatchObject({ status: 'PENDING_UPLOAD' });
    expect(res.body.attachment.fileName).toBe('trace.log'); // path stripped
    expect(upload.upload.headers).toMatchObject({ 'Content-Type': 'text/plain' });

    // Not listed until completed.
    let list = await t.http.get(`/api/v1/issues/${w.issueId}/attachments`).set(w.viewer.auth);
    expect(list.body).toEqual([]);

    expect((await put(upload, TEXT)).status).toBe(200);
    const done = await t.http
      .post(`/api/v1/attachments/${upload.attachment.id}/complete`)
      .set(w.dev.auth)
      .expect(200);
    expect(done.body).toMatchObject({ status: 'AVAILABLE', sizeBytes: TEXT.length });
    // Completing again is harmless.
    await t.http
      .post(`/api/v1/attachments/${upload.attachment.id}/complete`)
      .set(w.dev.auth)
      .expect(200);

    list = await t.http.get(`/api/v1/issues/${w.issueId}/attachments`).set(w.viewer.auth);
    expect(list.body).toEqual([
      expect.objectContaining({
        id: upload.attachment.id,
        uploadedBy: expect.objectContaining({ displayName: 'Dev' }),
      }),
    ]);
    const events = await t.prisma.issueEvent.findMany({
      where: { issueId: w.issueId, type: 'ATTACHMENT_ADDED' },
    });
    expect(events).toHaveLength(1);

    // Viewers can download through a short-lived link; the file is served as a download.
    const link = await t.http
      .get(`/api/v1/attachments/${upload.attachment.id}/download`)
      .set(w.viewer.auth)
      .expect(200);
    const file = await fetch(link.body.url as string);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe(TEXT);
    expect(file.headers.get('content-disposition')).toMatch(/^attachment; filename="trace\.log"/);
  });

  it('storage rejects bodies that differ from the signed size or type', async () => {
    const w = await world();
    const upload = (await requestUpload(w, w.dev).expect(201)).body as Upload;
    expect((await put(upload, `${TEXT}extra bytes`)).status).toBe(403);
    expect(
      (await put(upload, TEXT, { ...upload.upload.headers, 'Content-Type': 'text/html' })).status,
    ).toBe(403);
    // Nothing reached storage, so completing is refused.
    await t.http
      .post(`/api/v1/attachments/${upload.attachment.id}/complete`)
      .set(w.dev.auth)
      .expect(409);
  });

  it('discards an upload whose stored object does not match the request', async () => {
    const w = await world();
    const upload = (await requestUpload(w, w.dev).expect(201)).body as Upload;
    const row = await t.prisma.attachment.findUniqueOrThrow({
      where: { id: upload.attachment.id },
    });
    // Simulate a client that bypassed the signed URL (e.g. leaked storage credentials).
    const admin = new S3Client({
      region: 'us-east-1',
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: 'forge', secretAccessKey: 'forge_dev_storage_secret' },
    });
    await admin.send(
      new PutObjectCommand({
        Bucket: 'forge-test',
        Key: row.storageKey,
        Body: '<html>not a log</html>',
        ContentType: 'text/html',
      }),
    );
    admin.destroy();

    await t.http
      .post(`/api/v1/attachments/${upload.attachment.id}/complete`)
      .set(w.dev.auth)
      .expect(400);
    expect(await t.prisma.attachment.count({ where: { id: upload.attachment.id } })).toBe(0);
    expect(await storage.stat(row.storageKey)).toBeNull();
  });

  it('validates the request: type allow-list, size limit, and a usable name', async () => {
    const w = await world();
    const bad = async (body: Record<string, unknown>, path: string) => {
      const res = await requestUpload(w, w.dev, body).expect(400);
      expect(res.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
    };
    await bad({ contentType: 'text/html' }, 'contentType');
    await bad({ contentType: 'image/svg+xml' }, 'contentType');
    await bad({ sizeBytes: 10 * 1024 * 1024 + 1 }, 'sizeBytes');
    await bad({ sizeBytes: 0 }, 'sizeBytes');
    await bad({ fileName: '/' }, 'fileName');
  });

  it('enforces project permissions', async () => {
    const w = await world();
    await requestUpload(w, w.viewer).expect(403);
    await requestUpload(w, w.outsider).expect(404);
    const id = await uploaded(w);
    await t.http.get(`/api/v1/attachments/${id}/download`).set(w.outsider.auth).expect(404);
    await t.http.get(`/api/v1/issues/${w.issueId}/attachments`).set(w.outsider.auth).expect(404);

    // Only the uploader can complete their own upload.
    const pending = (await requestUpload(w, w.dev).expect(201)).body as Upload;
    await t.http
      .post(`/api/v1/attachments/${pending.attachment.id}/complete`)
      .set(w.pm.auth)
      .expect(403);
  });

  it('lets the uploader or a project manager delete, from storage too', async () => {
    const w = await world();
    const id = await uploaded(w);
    const { storageKey } = await t.prisma.attachment.findUniqueOrThrow({ where: { id } });

    await t.http.delete(`/api/v1/attachments/${id}`).set(w.dev2.auth).expect(403);
    await t.http.delete(`/api/v1/attachments/${id}`).set(w.viewer.auth).expect(403);
    await t.http.delete(`/api/v1/attachments/${id}`).set(w.pm.auth).expect(204);

    expect(await storage.stat(storageKey)).toBeNull();
    await t.http.get(`/api/v1/attachments/${id}/download`).set(w.dev.auth).expect(404);
    const removed = await t.prisma.issueEvent.findFirst({
      where: { issueId: w.issueId, type: 'ATTACHMENT_REMOVED' },
    });
    expect(removed?.oldValue).toEqual({ id, name: 'trace.log' });

    const own = await uploaded(w, w.dev2);
    await t.http.delete(`/api/v1/attachments/${own}`).set(w.dev2.auth).expect(204);
  });

  it('is read-only in archived projects and hidden with deleted issues', async () => {
    const w = await world();
    const id = await uploaded(w);
    await t.http.post(`/api/v1/projects/${w.project.id}/archive`).set(w.pm.auth).expect(200);
    await requestUpload(w, w.dev).expect(409);
    await t.http.get(`/api/v1/attachments/${id}/download`).set(w.dev.auth).expect(200);
    await t.http.post(`/api/v1/projects/${w.project.id}/restore`).set(w.pm.auth).expect(200);

    await t.http.delete(`/api/v1/issues/${w.issueId}`).set(w.pm.auth).expect(204);
    await t.http.get(`/api/v1/attachments/${id}/download`).set(w.dev.auth).expect(404);
  });

  it('cleanup removes uploads that were never completed, from storage and the database', async () => {
    const w = await world();
    const stale = (await requestUpload(w, w.dev).expect(201)).body as Upload;
    expect((await put(stale, TEXT)).status).toBe(200); // uploaded but never confirmed
    const fresh = (await requestUpload(w, w.dev).expect(201)).body as Upload;
    const done = await uploaded(w);
    await t.prisma.attachment.update({
      where: { id: stale.attachment.id },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });
    const staleKey = (
      await t.prisma.attachment.findUniqueOrThrow({ where: { id: stale.attachment.id } })
    ).storageKey;

    const cleanup = new AttachmentCleanup(t.prisma, storage);
    expect(await cleanup.removeAbandonedUploads()).toBeGreaterThanOrEqual(1);

    const remaining = await t.prisma.attachment.findMany({ where: { issueId: w.issueId } });
    expect(remaining.map((a) => a.id).sort()).toEqual([fresh.attachment.id, done].sort());
    expect(await storage.stat(staleKey)).toBeNull();
  });
});
