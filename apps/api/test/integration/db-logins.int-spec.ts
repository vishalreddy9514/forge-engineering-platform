import { Client } from 'pg';

import { ensureLogin } from '../../prisma/db-logins';
import { PG, databaseUrl, uid } from './helpers';

// The migrate job runs prisma/db-logins.ts after the migrations (docs/deployment.md).
describe('database logins (prisma/db-logins.ts)', () => {
  let admin: Client;
  const created: string[] = [];
  const password = (seed: string) => `${seed}_${uid()}${uid()}${uid()}${uid()}`;

  async function loginAs(group: string, secret: string): Promise<{ db: Client; login: string }> {
    const login = `${group}_login_${uid()}`;
    created.push(login);
    await ensureLogin(admin, { group, login }, secret);
    return { db: await connectAs(login, secret), login };
  }

  async function connectAs(login: string, secret: string): Promise<Client> {
    const url = new URL(databaseUrl());
    url.username = login;
    url.password = secret;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    return client;
  }

  const denied = { code: PG.INSUFFICIENT_PRIVILEGE };

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl() });
    await admin.connect();
  });

  afterAll(async () => {
    for (const login of created)
      await admin.query(`DROP ROLE IF EXISTS ${admin.escapeIdentifier(login)}`);
    await admin.end();
  });

  describe('the API and worker login (forge_app)', () => {
    let app: Client;

    beforeAll(async () => {
      ({ db: app } = await loginAs('forge_app', password('app')));
    });
    afterAll(() => app.end());

    it('reads and writes rows in every application table', async () => {
      await app.query('BEGIN');
      try {
        const { rows } = await app.query<{ id: string }>(
          `INSERT INTO users (id, email, display_name, password_hash, updated_at)
           VALUES (gen_random_uuid(), $1, 'Least Privilege', 'x', now()) RETURNING id`,
          [`lp-${uid()}@example.test`],
        );
        await app.query(`UPDATE users SET display_name = 'Renamed' WHERE id = $1`, [rows[0]?.id]);
        await app.query(`DELETE FROM users WHERE id = $1`, [rows[0]?.id]);
        await expect(app.query('SELECT count(*) FROM document_chunks')).resolves.toBeTruthy();
      } finally {
        await app.query('ROLLBACK');
      }
    });

    it('can add to the audit log but never change or remove an entry', async () => {
      await expect(app.query('SELECT count(*) FROM audit_logs')).resolves.toBeTruthy();
      await expect(app.query(`UPDATE audit_logs SET action = 'x'`)).rejects.toMatchObject(denied);
      await expect(app.query('DELETE FROM audit_logs')).rejects.toMatchObject(denied);
    });

    it('cannot change the schema, truncate tables or read migration history', async () => {
      await expect(app.query('CREATE TABLE lp_probe (id int)')).rejects.toMatchObject(denied);
      await expect(app.query('DROP TABLE users')).rejects.toMatchObject(denied);
      await expect(app.query('ALTER TABLE users ADD COLUMN lp int')).rejects.toMatchObject(denied);
      await expect(app.query('TRUNCATE notifications')).rejects.toMatchObject(denied);
      await expect(
        app.query('DROP TRIGGER audit_logs_append_only ON audit_logs'),
      ).rejects.toMatchObject(denied);
      await expect(app.query('SELECT * FROM _prisma_migrations')).rejects.toMatchObject(denied);
    });

    it('gets the same rights on tables that later migrations create', async () => {
      const table = `lp_later_${uid()}`;
      await admin.query(`CREATE TABLE ${table} (id serial PRIMARY KEY, note text)`);
      try {
        await expect(app.query(`INSERT INTO ${table} (note) VALUES ('ok')`)).resolves.toBeTruthy();
      } finally {
        await admin.query(`DROP TABLE ${table}`);
      }
    });

    it('is an ordinary role', async () => {
      const { rows } = await app.query<Record<string, boolean>>(
        `SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      expect(rows[0]).toEqual({
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolbypassrls: false,
      });
    });
  });

  describe('the AI service login (forge_ai)', () => {
    it('inherits only the forge_ai grants', async () => {
      const { db: ai } = await loginAs('forge_ai', password('ai'));
      try {
        await expect(ai.query('SELECT count(*) FROM documents')).resolves.toBeTruthy();
        await expect(ai.query('SELECT 1 FROM users LIMIT 1')).rejects.toMatchObject(denied);
      } finally {
        await ai.end();
      }
    });
  });

  it('is idempotent and rotates the password on a re-run', async () => {
    const login = `forge_app_login_${uid()}`;
    created.push(login);
    const old = password('old');
    const rotated = password('rotated');
    await ensureLogin(admin, { group: 'forge_app', login }, old);
    await ensureLogin(admin, { group: 'forge_app', login }, rotated);

    await expect(connectAs(login, old)).rejects.toThrow(/password authentication failed/);
    const db = await connectAs(login, rotated);
    await db.end();
  });

  it('escapes the password rather than interpolating it', async () => {
    const tricky = `${password('q')}'; DROP TABLE users; --`;
    const { db } = await loginAs('forge_app', tricky);
    await db.end();
    await expect(admin.query('SELECT count(*) FROM users')).resolves.toBeTruthy();
  });

  it('refuses short passwords, and a group the migrations have not created', async () => {
    await expect(
      ensureLogin(admin, { group: 'forge_app', login: 'unused' }, 'short'),
    ).rejects.toThrow(/at least 32/);
    await expect(
      ensureLogin(admin, { group: 'forge_missing', login: 'unused' }, password('p')),
    ).rejects.toThrow(/forge_missing is missing/);
  });
});
