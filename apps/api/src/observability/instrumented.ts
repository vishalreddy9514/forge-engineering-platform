import { DelayedError, type Job, UnrecoverableError } from 'bullmq';

import { isSafeRequestId } from '../common/http/request-id';
import { reportError } from './errors';
import { jobDuration, jobsDeadLettered } from './metrics';
import { runWithRequestId } from './request-context';

type Process = (job: Job, token?: string) => Promise<unknown>;

/**
 * Measures every attempt of a BullMQ processor and runs it under the request ID that enqueued
 * the job, so its logs (and its calls to the AI service) carry the same ID as the request.
 *
 *   @Instrumented(QUEUES.EMAIL)
 *   @Processor(QUEUES.EMAIL)
 *   export class EmailProcessor extends WorkerHost { async process(job) { ... } }
 */
export function Instrumented(queue: string): ClassDecorator {
  return (target) => {
    const prototype = target.prototype as { process: Process };
    const process = prototype.process;
    prototype.process = function (this: unknown, job: Job, token?: string) {
      return runJob(queue, job, () => process.call(this, job, token));
    };
  };
}

export async function runJob<T>(queue: string, job: Job, attempt: () => Promise<T>): Promise<T> {
  const data = job.data as { requestId?: unknown } | undefined;
  // Scheduled and system jobs have no originating request: their own ID is just as traceable.
  const requestId = isSafeRequestId(data?.requestId)
    ? data.requestId
    : `${queue}-${job.id ?? 'job'}`;
  const end = jobDuration.startTimer({ queue, job: job.name });

  return runWithRequestId(requestId, async () => {
    try {
      const result = await attempt();
      end({ outcome: 'completed' });
      return result;
    } catch (error) {
      // A DelayedError is a postponement (a GitHub rate limit), not a failed attempt.
      if (error instanceof DelayedError) {
        end({ outcome: 'delayed' });
        throw error;
      }
      end({ outcome: 'failed' });
      // Read defensively: instrumentation must never replace the processor's own error.
      const { attemptsMade = 0, opts } = job as Partial<Pick<Job, 'attemptsMade' | 'opts'>>;
      const lastAttempt = attemptsMade + 1 >= (opts?.attempts ?? 1);
      if (error instanceof UnrecoverableError || lastAttempt) {
        jobsDeadLettered.inc({ queue, job: job.name });
        // Only the final failure: retried attempts that later succeed are not incidents.
        reportError(error, { queue, job: job.name });
      }
      throw error;
    }
  });
}
