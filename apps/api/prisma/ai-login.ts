/**
 * Creates or updates the AI service's database login (AWS only; docker compose does the same in
 * infrastructure/docker/postgres/init/02-ai-service-role.sh).
 *
 * The migrations own the NOLOGIN group role `forge_ai` and its grants on the RAG tables
 * (ADR-0004). The login that inherits them has a password, which must never be in a migration,
 * so the one-shot migrate task runs this after `prisma migrate deploy`, with the password from
 * SSM Parameter Store. Re-running it sets the password again, which is how it is rotated.
 */
import { Client, type ClientBase } from 'pg';

export const AI_LOGIN_ROLE = 'forge_ai_service';

export async function ensureAiLogin(
  db: ClientBase,
  password: string,
  login = AI_LOGIN_ROLE,
): Promise<void> {
  if (password.length < 32) throw new Error('AI_DB_PASSWORD must be at least 32 characters');
  const { rowCount } = await db.query(`SELECT 1 FROM pg_roles WHERE rolname = 'forge_ai'`);
  if (!rowCount) throw new Error('Role forge_ai is missing: run `prisma migrate deploy` first');

  const role = db.escapeIdentifier(login);
  const secret = db.escapeLiteral(password);
  const exists = await db.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [login]);
  // DDL takes no bind parameters; both values are escaped by the driver above.
  await db.query(
    exists.rowCount
      ? `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${secret}`
      : `CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${secret}`,
  );
  await db.query(`GRANT forge_ai TO ${role}`);
}

async function main(): Promise<void> {
  const password = process.env.AI_DB_PASSWORD;
  if (!process.env.DATABASE_URL || !password) {
    throw new Error('DATABASE_URL and AI_DB_PASSWORD must be set');
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await ensureAiLogin(db, password);
    console.log(`Database login ${AI_LOGIN_ROLE} is ready.`);
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
