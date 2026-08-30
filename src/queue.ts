export const QUEUE_TERMINAL_STATUSES = [
  "completed", "failed", "blocked", "unknown", "login-required", "rate-limited", "account-blocked",
  "changed-ui", "validation-rejected", "browser-failed", "queued",
] as const;
export type QueueTerminalStatus = (typeof QUEUE_TERMINAL_STATUSES)[number];
export type QueueFailureCategory =
  | "browser-failure" | "login" | "challenge" | "validation" | "rate-limit" | "account-block"
  | "changed-ui" | "ambiguous" | "failed";

export interface QueuePreparedJob<T> {
  id: string;
  value: T;
  submissionAttempted: boolean;
  terminal?: QueueJobResult;
}

export interface QueueJobResult {
  status: QueueTerminalStatus;
  exitCode: number;
  category?: QueueFailureCategory;
  submissionAttempted: boolean;
}

export interface QueueOptions {
  concurrency: 1 | 2;
  retries: 0 | 1;
}

export interface QueueRuntime<Input, Job, Session, Handle> {
  prepare(input: Input, position: number): Promise<QueuePreparedJob<Job>>;
  launch(): Promise<Session>;
  open(session: Session): Promise<Handle>;
  run(job: QueuePreparedJob<Job>, handle: Handle, attempt: number): Promise<QueueJobResult>;
  closeHandle(handle: Handle): Promise<void>;
  closeSession(session: Session): Promise<void>;
}

export interface QueueRunResult {
  exitCode: number;
  results: QueueJobResult[];
  counts: Partial<Record<QueueTerminalStatus, number>>;
}

export type QueueReporter = (line: string) => void;

export async function runQueue<Input, Job, Session, Handle>(
  inputs: readonly Input[],
  options: QueueOptions,
  runtime: QueueRuntime<Input, Job, Session, Handle>,
  report: QueueReporter = console.log,
): Promise<QueueRunResult> {
  const prepared: QueuePreparedJob<Job>[] = [];
  for (let index = 0; index < inputs.length; index += 1) {
    const job = await runtime.prepare(inputs[index]!, index);
    prepared.push(job);
    reportLine(report, index, inputs.length, job.id, "queued");
  }

  const results: Array<QueueJobResult | undefined> = new Array(prepared.length);
  const runnable = prepared.some((job) => !job.terminal);
  let session: Session | undefined;
  if (runnable) {
    const launchAttempts = options.retries + 1;
    for (let attempt = 1; attempt <= launchAttempts; attempt += 1) {
      try {
        session = await runtime.launch();
        break;
      } catch {
        const retryable = attempt < launchAttempts && prepared.every((job) => job.terminal || !job.submissionAttempted);
        if (!retryable) break;
        prepared.forEach((job, index) => {
          if (!job.terminal) reportLine(report, index, prepared.length, job.id, "retrying", attempt + 1);
        });
      }
    }
  }

  if (runnable && session === undefined) {
    prepared.forEach((job, index) => {
      results[index] = job.terminal ?? { status: "browser-failed", exitCode: 4, category: "browser-failure", submissionAttempted: job.submissionAttempted };
      reportLine(report, index, prepared.length, job.id, results[index]!.status);
    });
    return summarize(results as QueueJobResult[], report);
  }

  let next = 0;
  let stopDispatch = false;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= prepared.length) return;
      const job = prepared[index]!;
      if (job.terminal) {
        results[index] = job.terminal;
        reportLine(report, index, prepared.length, job.id, job.terminal.status);
        continue;
      }
      if (stopDispatch) {
        results[index] = { status: "queued", exitCode: 9, submissionAttempted: job.submissionAttempted };
        reportLine(report, index, prepared.length, job.id, "queued");
        continue;
      }

      let result: QueueJobResult | undefined;
      for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
        reportLine(report, index, prepared.length, job.id, "running", attempt > 1 ? attempt : undefined);
        let handle: Handle | undefined;
        try {
          handle = await runtime.open(session!);
        } catch {
          result = { status: "browser-failed", exitCode: 4, category: "browser-failure", submissionAttempted: job.submissionAttempted };
        }
        if (handle !== undefined) {
          try {
            result = await runtime.run(job, handle, attempt);
          } catch {
            result = { status: "unknown", exitCode: 10, category: "ambiguous", submissionAttempted: true };
          } finally {
            await runtime.closeHandle(handle).catch(() => undefined);
          }
        }
        if (!eligibleForRetry(result!, attempt, options.retries)) break;
        reportLine(report, index, prepared.length, job.id, "retrying", attempt + 1);
      }
      results[index] = result!;
      if (result!.status === "rate-limited" || result!.status === "account-blocked") stopDispatch = true;
      reportLine(report, index, prepared.length, job.id, result!.status);
    }
  };

  if (!runnable || session !== undefined) {
    try {
      await Promise.all(Array.from({ length: options.concurrency }, worker));
    } finally {
      if (session !== undefined) await runtime.closeSession(session).catch(() => undefined);
    }
  }
  return summarize(results as QueueJobResult[], report);
}

export function eligibleForRetry(result: QueueJobResult, attempt: number, retries: number): boolean {
  return attempt <= retries && result.category === "browser-failure" && !result.submissionAttempted;
}

function reportLine(
  report: QueueReporter,
  index: number,
  total: number,
  id: string,
  status: string,
  attempt?: number,
): void {
  report(`Queue ${index + 1}/${total} ${id.slice(0, 8)}${attempt === undefined ? "" : ` attempt ${attempt}`} ${status}.`);
}

function summarize(results: QueueJobResult[], report: QueueReporter): QueueRunResult {
  const counts: Partial<Record<QueueTerminalStatus, number>> = {};
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  report(`Queue summary: ${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(" ")}.`);
  return {
    exitCode: results.every((result) => result.status === "completed") ? 0 : Math.max(...results.map((result) => result.exitCode)),
    results,
    counts,
  };
}
