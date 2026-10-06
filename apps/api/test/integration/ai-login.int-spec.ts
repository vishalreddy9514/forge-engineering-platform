import { Client } from 'pg';

import { ensureAiLogin } from '../../prisma/ai-login';
import { PG, databaseUrl, uid } from './helpers';

// The AWS migrate task runs prisma/ai-login.ts after the migrations (docs/deployment.md).
describe('AI service login bootstrap (prisma/ai-login.ts)', () => {
  let admin: Client;
  const login = `forge_ai_login_${uid()}`;
  const password = (seed: string) => `${seed}_${uid()}${uid()}${uid()}${uid()}`;

  async function connectAs(secret: string): Promise<Client> {
    const url = new URL(databaseUrl());
    url.username = login;
    url.password = secret;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    return client;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl() });
    await admin.connect();
  });

  afterAll(async () => {
    await admin.query(`DROP ROLE IF EXISTS ${admin.escapeIdentifier(login)}`);
    await admin.end();
  });

  it('creates a login that inherits only the forge_ai grants', async () => {
    const secret = password('first');
    await ensureAiLogin(admin, secret, login);

    const ai = await connectAs(secret);
    try {
      await expect(ai.query('SELECT count(*) FROM documents')).resolves.toBeTruthy();
      await expect(ai.query('SELECT 1 FROM users LIMIT 1')).rejects.toMatchObject({
        code: PG.INSUFFICIENT_PRIVILEGE,
      });
      const { rows } = await ai.query<{ rolsuper: boolean; rolcreaterole: boolean }>(
        'SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user',
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolcreaterole: false });
    } finally {
      await ai.end();
    }
  });

  it('is idempotent and rotates the password on a re-run', async () => {
    const old = password('old');
    const rotated = password('rotated');
    await ensureAiLogin(admin, old, login);
    await ensureAiLogin(admin, rotated, login);

    await expect(connectAs(old)).rejects.toThrow(/password authentication failed/);
    const ai = await connectAs(rotated);
    await ai.end();
  });

  it('escapes the password rather than interpolating it', async () => {
    const tricky = `${password('q')}'; DROP TABLE users; --`;
    await ensureAiLogin(admin, tricky, login);
    const ai = await connectAs(tricky);
    await ai.end();
    await expect(admin.query('SELECT count(*) FROM users')).resolves.toBeTruthy();
  });

  it('refuses short passwords', async () => {
    await expect(ensureAiLogin(admin, 'short', login)).rejects.toThrow(/at least 32/);
  });
});
