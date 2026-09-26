import { PrismaPg } from '@prisma/adapter-pg';
import { createHash } from 'node:crypto';

import { PrismaClient } from '../../src/generated/prisma/client';
import {
  PG,
  createIssue,
  createPrisma,
  createProject,
  databaseUrl,
  oneHotEmbedding,
  sqlState,
  uid,
} from './helpers';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('RAG storage (documents, chunks, pgvector)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrisma();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createDocument(projectId: string, title = 'Runbook') {
    return prisma.document.create({
      data: {
        projectId,
        sourceType: 'UPLOAD',
        title,
        content: `${title} content`,
        url: `/projects/${projectId}/docs/${uid()}`,
        contentHash: sha256(title),
      },
    });
  }

  function insertChunk(
    documentId: string,
    projectId: string,
    chunkIndex: number,
    content: string,
    embedding: string,
  ) {
    // Chunks are written with SQL by the AI service (Prisma cannot write vector columns).
    return prisma.$executeRaw`
      INSERT INTO document_chunks
        (document_id, project_id, chunk_index, content, token_count, content_hash,
         embedding_model, embedding)
      VALUES (${documentId}::uuid, ${projectId}::uuid, ${chunkIndex}, ${content}, 12,
              ${sha256(content)}, 'text-embedding-3-small', ${embedding}::vector)`;
  }

  it('requires a source row for every source type except uploads', async () => {
    const project = await createProject(prisma);
    await expect(
      sqlState(
        prisma.document.create({
          data: {
            projectId: project.id,
            sourceType: 'ISSUE',
            title: 'Missing source',
            content: 'x',
            url: '/x',
            contentHash: sha256('x'),
          },
        }),
      ),
    ).resolves.toBe(PG.CHECK_VIOLATION);
  });

  it('indexes each source at most once', async () => {
    const project = await createProject(prisma);
    const issue = await createIssue(prisma, project.id, project.createdById);
    const data = {
      projectId: project.id,
      sourceType: 'ISSUE' as const,
      sourceId: issue.id,
      title: 'Issue',
      content: 'x',
      url: '/x',
      contentHash: sha256('x'),
    };
    await prisma.document.create({ data });
    await expect(sqlState(prisma.document.create({ data }))).resolves.toBe(PG.UNIQUE_VIOLATION);
  });

  it("refuses a chunk whose project differs from its document's (composite FK)", async () => {
    const [mine, other] = await Promise.all([createProject(prisma), createProject(prisma)]);
    const document = await createDocument(mine.id);
    await expect(
      sqlState(insertChunk(document.id, other.id, 0, 'leaked', oneHotEmbedding(0))),
    ).resolves.toBe(PG.FOREIGN_KEY_VIOLATION);
  });

  it('finds nearest neighbours by cosine distance, filtered by project', async () => {
    const [mine, other] = await Promise.all([createProject(prisma), createProject(prisma)]);
    const doc = await createDocument(mine.id);
    const otherDoc = await createDocument(other.id);
    await insertChunk(doc.id, mine.id, 0, 'password reset flow', oneHotEmbedding(1));
    await insertChunk(doc.id, mine.id, 1, 'payment retries', oneHotEmbedding(2));
    // Identical vector to the query, but in a project the caller cannot see.
    await insertChunk(otherDoc.id, other.id, 0, 'secret incident notes', oneHotEmbedding(1));

    const results = await prisma.$queryRaw<{ content: string; distance: number }[]>`
      SELECT content, embedding <=> ${oneHotEmbedding(1)}::vector AS distance
      FROM document_chunks
      WHERE project_id = ANY(${[mine.id]}::uuid[])
      ORDER BY embedding <=> ${oneHotEmbedding(1)}::vector
      LIMIT 5`;

    expect(results.map((r) => r.content)).toEqual(['password reset flow', 'payment retries']);
    expect(results[0]?.distance).toBeCloseTo(0);
    expect(results[1]?.distance).toBeCloseTo(1);
  });

  it('serves the similarity query from the HNSW index', async () => {
    // With a handful of rows the planner would rightly choose a sequential scan, so disable it
    // for this transaction to prove the index exists and matches the query's operator.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<{ 'QUERY PLAN': string }[]>`
        EXPLAIN SELECT id FROM document_chunks
        ORDER BY embedding <=> ${oneHotEmbedding(3)}::vector LIMIT 5`;
    });
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'document_chunks_embedding_hnsw_idx',
    );
  });

  it('deletes chunks with their document', async () => {
    const project = await createProject(prisma);
    const document = await createDocument(project.id);
    await insertChunk(document.id, project.id, 0, 'temporary', oneHotEmbedding(4));

    await prisma.document.delete({ where: { id: document.id } });
    await expect(prisma.documentChunk.count({ where: { documentId: document.id } })).resolves.toBe(
      0,
    );
  });

  describe('forge_ai database role (least privilege, ADR-0004)', () => {
    let ai: PrismaClient;
    const login = `forge_ai_test_${uid()}`;
    const password = `pw_${uid()}${uid()}`;

    beforeAll(async () => {
      // Role names and passwords cannot be bound as parameters; both values are generated above.
      // eslint-disable-next-line no-restricted-properties -- test-generated identifiers only
      await prisma.$executeRawUnsafe(
        `CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE forge_ai`,
      );
      const url = new URL(databaseUrl());
      url.username = login;
      url.password = password;
      ai = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
    });

    afterAll(async () => {
      await ai.$disconnect();
      // eslint-disable-next-line no-restricted-properties -- test-generated identifier only
      await prisma.$executeRawUnsafe(`DROP ROLE ${login}`);
    });

    it('can read and write RAG tables', async () => {
      const project = await createProject(prisma);
      const document = await createDocument(project.id);
      await expect(
        ai.$executeRaw`
          INSERT INTO document_chunks
            (document_id, project_id, chunk_index, content, token_count, content_hash,
             embedding_model, embedding)
          VALUES (${document.id}::uuid, ${project.id}::uuid, 0, 'from ai', 3, ${sha256('a')},
                  'm', ${oneHotEmbedding(5)}::vector)`,
      ).resolves.toBe(1);
      await expect(ai.document.count({ where: { id: document.id } })).resolves.toBe(1);
    });

    it.each(['users', 'refresh_tokens', 'issues', 'project_members', 'audit_logs'])(
      'cannot read %s',
      async (table) => {
        // Table names cannot be bound as parameters; the list above is a fixed allowlist.
        // eslint-disable-next-line no-restricted-properties -- fixed allowlist of identifiers
        const query = ai.$queryRawUnsafe(`SELECT 1 FROM ${table} LIMIT 1`);
        await expect(sqlState(query)).resolves.toBe(PG.INSUFFICIENT_PRIVILEGE);
      },
    );

    it('can record usage but not read other usage rows', async () => {
      await expect(
        ai.$executeRaw`
          INSERT INTO ai_usage (feature, model, input_tokens, latency_ms, cost_usd, success)
          VALUES ('EMBEDDING', 'text-embedding-3-small', 100, 50, 0.000002, true)`,
      ).resolves.toBe(1);
      await expect(sqlState(ai.$queryRaw`SELECT * FROM ai_usage LIMIT 1`)).resolves.toBe(
        PG.INSUFFICIENT_PRIVILEGE,
      );
    });
  });
});
