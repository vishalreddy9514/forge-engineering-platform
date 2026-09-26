import type { Prisma } from '../generated/prisma/client';

/**
 * Hands out the next per-project issue number (PAY-1, PAY-2, …).
 *
 * `UPDATE projects SET issue_seq = issue_seq + 1 … RETURNING` takes a row lock that is held
 * until the surrounding transaction ends, so concurrent creates in the same project queue up
 * behind each other instead of reading the same value. If the transaction rolls back, the
 * increment rolls back with it, so numbers have no gaps. Creates in different projects never
 * contend. Must be called inside the transaction that inserts the issue.
 */
export async function allocateIssueNumber(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<number> {
  const { issueSeq } = await tx.project.update({
    where: { id: projectId },
    data: { issueSeq: { increment: 1 } },
    select: { issueSeq: true },
  });
  return issueSeq;
}
