/**
 * Creates or updates the database logins the services run as. The migrate job runs this after
 * `prisma migrate deploy`, in AWS and in the containerised stack.
 *
 * The migrations own the NOLOGIN group roles and their grants (ADR-0004):
 * - `forge_app`: the API and worker. Reads and writes rows; no DDL, an insert-only audit log.
 * - `forge_ai`: the AI service. The RAG tables only.
 * The logins that inherit them have passwords, which must never be in a migration, so they are
 * created here from the environment (SSM Parameter Store in AWS). Re-running sets the password
 * again, which is how it is rotated.
 */
import { Client, type ClientBase } from 'pg';

export interface Login {
  /** The NOLOGIN role (from the migrations) whose grants the login inherits. */
  group: string;
  login: string;
  /** The environment variable holding the password. */
  passwordEnv: string;
}

export const LOGINS: readonly Login[] = [
  { group: 'forge_app', login: 'forge_app_service', passwordEnv: 'APP_DB_PASSWORD' },
  { group: 'forge_ai', login: 'forge_ai_service', passwordEnv: 'AI_DB_PASSWORD' },
];

export async function ensureLogin(
  db: ClientBase,
  { group, login }: Pick<Login, 'group' | 'login'>,
  password: string,
): Promise<void> {
  if (password.length < 32)
    throw new Error(`The password for ${login} must be at least 32 characters`);
  const { rowCount } = await db.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [group]);
  if (!rowCount) throw new Error(`Role ${group} is missing: run \`prisma migrate deploy\` first`);

  const role = db.escapeIdentifier(login);
  const secret = db.escapeLiteral(password);
  const exists = await db.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [login]);
  // DDL takes no bind parameters; every value is escaped by the driver above.
  await db.query(
    exists.rowCount
      ? `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${secret}`
      : `CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${secret}`,
  );
  await db.query(`GRANT ${db.escapeIdentifier(group)} TO ${role}`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set');
  // A login whose password is not provided is left alone: locally the AI service's login is
  // created when the Postgres volume is (infrastructure/docker/postgres/init). In AWS the
  // migrate task always passes both.
  const wanted = LOGINS.filter((l) => process.env[l.passwordEnv]);
  if (!wanted.length) throw new Error(`Set ${LOGINS.map((l) => l.passwordEnv).join(' or ')}`);

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    for (const login of wanted) {
      await ensureLogin(db, login, process.env[login.passwordEnv] ?? '');
      console.log(`Database login ${login.login} is ready.`);
    }
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
