import {
  createTrackedJob,
  jobIdentifier,
  resumeAction,
  transitionJob,
  type SunoJob,
  type TrackedJob,
} from "../domain/job.js";
import { runQueue, type QueueJobResult, type QueueRunResult } from "../queue.js";
import type { AutomationOutcome, JobRepository, SunoAutomation, SunoSession } from "./contracts.js";

export interface RunJobsRequest {
  jobs: SunoJob[];
  concurrency: 1 | 2;
  retries: 0 | 1;
}

export interface RunJobsDependencies {
  repository: JobRepository;
  automation: SunoAutomation;
}

interface PreparedJob {
  job: TrackedJob;
  action: "submit" | "observe";
}

export async function runJobs(
  request: RunJobsRequest,
  dependencies: RunJobsDependencies,
  report: (line: string) => void = console.log,
): Promise<QueueRunResult> {
  const { repository, automation } = dependencies;
  return runQueue(request.jobs, request, {
    prepare: async (input) => {
      const id = jobIdentifier(input);
      const saved = await repository.load(id);
      let job = saved ?? createTrackedJob(input);
      if (!saved) await repository.save(job);
      const action = resumeAction(job, await repository.outputsExist(job));
      if (action === "complete") return { id, value: { job, action: "observe" as const }, submissionAttempted: true, terminal: queueResult(0, job) };
      if (action === "review") {
        job = transitionJob(job, "unknown", new Date(), {
          code: "submission-unconfirmed",
          message: "Submission may have occurred before confirmation. Inspect the visible browser; this job will not be submitted again.",
        });
        await repository.save(job);
        return { id, value: { job, action: "observe" as const }, submissionAttempted: true, terminal: queueResult(10, job) };
      }
      return { id, value: { job, action: action as "submit" | "observe" }, submissionAttempted: Boolean(job.submission.attemptedAt) };
    },
    launch: () => automation.open(),
    open: async (session) => session,
    run: async (prepared, session) => execute(prepared.value, session, repository),
    closeHandle: async () => undefined,
    closeSession: (session) => session.close(),
  }, report);
}

async function execute(prepared: PreparedJob, session: SunoSession, repository: JobRepository): Promise<QueueJobResult> {
  let job = prepared.job;
  if (prepared.action === "submit") {
    const submission = await session.submit(job, async () => {
      job = { ...job, submission: { ...job.submission, attemptedAt: new Date().toISOString() } };
      await repository.save(job);
    });
    if (submission.status !== "accepted" || !submission.receipt) return saveOutcome(job, submission, repository);
    job = transitionJob({
      ...job,
      submission: { ...job.submission, confirmedAt: new Date().toISOString(), receipt: submission.receipt },
    }, "running");
    await repository.save(job);
  }
  return saveOutcome(job, await session.observe(job), repository);
}

async function saveOutcome(job: TrackedJob, outcome: AutomationOutcome, repository: JobRepository): Promise<QueueJobResult> {
  if (outcome.status === "completed") {
    const completed = transitionJob({ ...job, outputs: outcome.outputs ?? job.outputs }, "completed");
    await repository.save(completed);
    return queueResult(0, completed);
  }
  const mapped = outcomeStatus(outcome);
  const updated = transitionJob(job, mapped.jobStatus, new Date(), { code: outcome.code ?? mapped.code, message: mapped.message });
  await repository.save(updated);
  return queueResult(mapped.exitCode, updated);
}

function outcomeStatus(outcome: AutomationOutcome): { jobStatus: "failed" | "blocked" | "unknown"; exitCode: number; code: string; message: string } {
  switch (outcome.status) {
    case "login-required": return { jobStatus: "blocked", exitCode: 3, code: "login-required", message: "Login is required in the dedicated visible browser profile." };
    case "challenge-required": return { jobStatus: "blocked", exitCode: 9, code: "challenge-required", message: "Complete the visible browser challenge, then rerun this job." };
    case "validation-rejected": return { jobStatus: "failed", exitCode: 5, code: "validation-error", message: "Suno visibly rejected the generation options." };
    case "rate-limited": return { jobStatus: "blocked", exitCode: 6, code: "rate-limited", message: "Suno visibly rate-limited this job." };
    case "account-blocked": return { jobStatus: "blocked", exitCode: 9, code: "account-blocked", message: "Suno visibly blocked this account action." };
    case "changed-ui": return { jobStatus: "unknown", exitCode: 7, code: "changed-ui", message: "The visible Suno controls no longer match the recorded baseline." };
    case "failed": return { jobStatus: "failed", exitCode: 8, code: "generation-failed", message: "Suno visibly rejected this generation." };
    default: return { jobStatus: "unknown", exitCode: 10, code: "submission-unknown", message: "The result is ambiguous; inspect the visible browser." };
  }
}

function queueResult(exitCode: number, job: TrackedJob): QueueJobResult {
  const submissionAttempted = Boolean(job.submission.attemptedAt);
  if (exitCode === 0) return { status: "completed", exitCode, submissionAttempted };
  if (job.error?.code === "account-blocked") return { status: "account-blocked", exitCode, category: "account-block", submissionAttempted };
  if (exitCode === 3) return { status: "login-required", exitCode, category: "login", submissionAttempted };
  if (exitCode === 6) return { status: "rate-limited", exitCode, category: "rate-limit", submissionAttempted };
  if (exitCode === 5) return { status: "validation-rejected", exitCode, category: "validation", submissionAttempted };
  if (exitCode === 7) return { status: "changed-ui", exitCode, category: "changed-ui", submissionAttempted };
  if (job.status === "blocked") return { status: "blocked", exitCode, category: job.error?.code === "challenge-required" ? "challenge" : "login", submissionAttempted };
  if (job.status === "failed") return { status: "failed", exitCode, category: "failed", submissionAttempted };
  return { status: "unknown", exitCode: Math.max(exitCode, 10), category: "ambiguous", submissionAttempted };
}
