import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { BrowserContext, Page } from "playwright";
import { launchSunoBrowser, isLoginRequired, openSunoPage, type SunoBrowser } from "./browser.js";
import { waitForChallengeContinue } from "./challenge.js";
import {
  downloadCompletedTracks,
  observeCompletion,
  type CompletionObservation,
  type DownloadLimits,
  type ObservationLimits,
} from "./completion.js";
import { createDiagnostic, createUnavailableDiagnostic, mapDiagnosticCategory, writeDiagnostic, type DiagnosticCategory, type DiagnosticStage } from "./diagnostics.js";
import { jobIdentifier, parseQueueRequest, type SunoJob } from "./job.js";
import { runQueue, type QueueJobResult, type QueuePreparedJob } from "./queue.js";
import { resolveJobPaths, resolveRuntimePaths, type JobPaths, type RuntimePaths } from "./runtime-paths.js";
import { submitSunoJob, type SubmissionHooks, type SubmissionOutcome } from "./submission.js";
import {
  createTrackedJob,
  loadTrackedJob,
  recordedOutputsExist,
  resumeAction,
  saveTrackedJob,
  transitionJob,
  type TrackedJob,
} from "./tracking.js";

const EXIT_INVALID_JOB = 2;
const EXIT_LOGIN_REQUIRED = 3;
const EXIT_BROWSER = 4;
const EXIT_VALIDATION = 5;
const EXIT_RATE_LIMITED = 6;
const EXIT_CHANGED_UI = 7;
const EXIT_FAILED = 8;
const EXIT_BLOCKED = 9;
const EXIT_UNKNOWN = 10;

export const DEFAULT_OBSERVATION_LIMITS: ObservationLimits = {
  maxAttempts: 120,
  deadlineMs: 30 * 60_000,
  intervalMs: 15_000,
};
export const DEFAULT_DOWNLOAD_LIMITS: DownloadLimits = { maxAttempts: 3, timeoutMs: 60_000 };

type LaunchBrowser = (paths: RuntimePaths) => Promise<SunoBrowser>;
type SubmitJob = (
  page: Page,
  job: SunoJob,
  waitForChallengeContinue: () => Promise<void>,
  navigation?: undefined,
  hooks?: SubmissionHooks,
) => Promise<SubmissionOutcome>;

export interface SessionDiagnostic {
  stage: DiagnosticStage;
  category: DiagnosticCategory;
}

export interface SessionDependencies {
  submit?: SubmitJob;
  loginRequired?: (page: Page) => Promise<boolean>;
  waitForChallenge?: () => Promise<void>;
  observationLimits?: ObservationLimits;
  downloadLimits?: DownloadLimits;
  quiet?: boolean;
  closeContext?: boolean;
  onDiagnostic?: (diagnostic: SessionDiagnostic) => void;
}

interface PreparedTrackedJob {
  job: TrackedJob;
  paths: JobPaths;
  action: "submit" | "observe";
}

export async function runCli(
  args: readonly string[],
  projectRoot = process.cwd(),
  launch: LaunchBrowser = launchSunoBrowser,
  dependencies: SessionDependencies = {},
): Promise<number> {
  let request;
  try {
    request = await parseQueueRequest(args);
  } catch {
    console.error("Invalid job or manifest. Check queue inputs and generation options.");
    return EXIT_INVALID_JOB;
  }

  const runtimePaths = resolveRuntimePaths(projectRoot);
  const preparedPaths = new Map<string, JobPaths>();
  let result;
  try {
    result = await runQueue(request.jobs, request, {
      prepare: async (requested): Promise<QueuePreparedJob<PreparedTrackedJob>> => {
        const id = jobIdentifier(requested);
        const paths = resolveJobPaths(runtimePaths, id);
        preparedPaths.set(id, paths);
        const saved = await loadTrackedJob(paths, id);
        let job = saved ?? createTrackedJob(requested);
        if (!saved) await saveTrackedJob(paths, job);
        const action = resumeAction(job, await recordedOutputsExist(job, paths));
        if (action === "complete") {
          return { id, value: { job, paths, action: "observe" }, submissionAttempted: true, terminal: queueResult(0, job) };
        }
        if (action === "review") {
          job = transitionJob(job, "unknown", new Date(), {
            code: "submission-unconfirmed",
            message: "Submission may have occurred before confirmation. Inspect the visible browser; this job will not be submitted again.",
          });
          await saveTrackedJob(paths, job);
          return { id, value: { job, paths, action: "observe" }, submissionAttempted: true, terminal: queueResult(EXIT_UNKNOWN, job) };
        }
        return { id, value: { job, paths, action }, submissionAttempted: Boolean(job.submission.attemptedAt) };
      },
      launch: async () => {
        const browser = await launch(runtimePaths);
        return { context: browser.context, available: [browser.page] };
      },
      open: async (session) => ({
        context: session.context,
        page: session.available.shift() ?? await openSunoPage(session.context),
      }),
      run: async (prepared, handle) => {
        const value = prepared.value;
        let sessionDiagnostic: SessionDiagnostic | undefined;
        const exit = await runBrowserSession(handle.context, handle.page, value.job, value.paths, value.action, {
          ...dependencies,
          quiet: true,
          closeContext: false,
          onDiagnostic: (diagnostic) => { sessionDiagnostic = diagnostic; },
        });
        const current = await loadTrackedJob(value.paths, prepared.id) ?? value.job;
        const queueOutcome = queueResult(exit, current);
        if (exit !== 0) {
          try {
            const classification = sessionDiagnostic ?? { stage: diagnosticStage(exit), category: diagnosticCategory(exit, current) };
            const diagnostic = await createDiagnostic(handle.page, prepared.id, classification.stage, classification.category);
            await writeDiagnostic(runtimePaths.root, value.paths.diagnostic, diagnostic);
          } catch { /* Diagnostic persistence is deliberately secondary to the job outcome. */ }
        }
        return queueOutcome;
      },
      closeHandle: async (handle) => { await handle.page.close?.().catch(() => undefined); },
      closeSession: (session) => session.context.close(),
    });
  } catch {
    console.error("Queue state is invalid. Review contained job state before retrying.");
    return EXIT_UNKNOWN;
  }

  for (let index = 0; index < result.results.length; index += 1) {
    const outcome = result.results[index]!;
    if (outcome.status === "completed") continue;
    const id = jobIdentifier(request.jobs[index]!);
    const paths = preparedPaths.get(id);
    if (!paths || await access(paths.diagnostic).then(() => true, () => false)) continue;
    const stage = outcome.status === "browser-failed" ? "launch" : outcome.status === "login-required" ? "preparation" : "submission";
    await writeDiagnostic(runtimePaths.root, paths.diagnostic, createUnavailableDiagnostic(
      id, stage, diagnosticCategoryForQueue(outcome),
    )).catch(() => undefined);
  }
  return result.exitCode;
}

export async function runBrowserSession(
  context: BrowserContext,
  page: Page,
  initialJob: TrackedJob,
  paths: JobPaths,
  action: "submit" | "observe",
  dependencies: SessionDependencies = {},
): Promise<number> {
  const submit = dependencies.submit ?? submitSunoJob;
  const loginRequired = dependencies.loginRequired ?? isLoginRequired;
  const waitForChallenge = dependencies.waitForChallenge ?? waitForChallengeContinue;
  let job = initialJob;
  let activeStage: DiagnosticStage = "preparation";

  try {
    if (action === "submit") {
      if (await loginRequired(page)) {
        if (!dependencies.quiet) console.error("Login required. Authenticate in the dedicated Chrome profile, then retry.");
        return sessionFailure(EXIT_LOGIN_REQUIRED, "preparation", "login-required", dependencies);
      }
      activeStage = "submission";
      const outcome = await submit(page, job, waitForChallenge, undefined, {
        beforeClick: async () => {
          job = { ...job, submission: { ...job.submission, attemptedAt: new Date().toISOString() } };
          await saveTrackedJob(paths, job);
        },
      });
      const preSubmissionExit = await applySubmissionOutcome(outcome, job, paths, dependencies.quiet ?? false);
      job = preSubmissionExit.job;
      if (preSubmissionExit.exit !== undefined) {
        return sessionFailure(preSubmissionExit.exit, "submission", diagnosticCategory(preSubmissionExit.exit, job), dependencies);
      }
    }

    const receipt = job.submission.receipt;
    if (!receipt) {
      job = transitionJob(job, "unknown", new Date(), {
        code: "missing-submission-receipt",
        message: "Submission was accepted without an exact visible track receipt. Inspect the visible browser.",
      });
      await saveTrackedJob(paths, job);
      return reportSessionJob(job, "submission", dependencies);
    }

    activeStage = "observation";
    const observation = await observeCompletion(
      page,
      receipt,
      { ...DEFAULT_OBSERVATION_LIMITS, ...dependencies.observationLimits, initialAttempts: job.observationAttempts },
      async (visible, attempt) => {
        job = applyObservation(job, visible, attempt);
        await saveTrackedJob(paths, job);
      },
    );
    if (observation.status !== "completed") return reportSessionJob(job, "observation", dependencies);

    activeStage = "download";
    job = await downloadCompletedTracks(
      page,
      paths,
      job,
      observation.tracks,
      dependencies.downloadLimits ?? DEFAULT_DOWNLOAD_LIMITS,
      async (updated) => saveTrackedJob(paths, updated),
    );
    return reportSessionJob(job, "download", dependencies);
  } catch {
    if (!dependencies.quiet) console.error(`Job ${job.id} stopped unexpectedly. Rerun it to continue tracking.`);
    const category = activeStage === "observation" ? "observation-failed" : activeStage === "download" ? "download-failed" : "unexpected";
    return sessionFailure(EXIT_BROWSER, activeStage, category, dependencies);
  } finally {
    if (dependencies.closeContext !== false) await context.close().catch(() => undefined);
  }
}

async function applySubmissionOutcome(
  outcome: SubmissionOutcome,
  current: TrackedJob,
  paths: JobPaths,
  quiet = false,
): Promise<{ job: TrackedJob; exit?: number }> {
  if (outcome.status === "submitted") {
    const confirmedAt = new Date().toISOString();
    let job: TrackedJob = {
      ...current,
      submission: {
        ...current.submission,
        confirmedAt,
        ...(outcome.receipt ? { receipt: outcome.receipt } : {}),
      },
    };
    job = transitionJob(job, "running");
    await saveTrackedJob(paths, job);
    return { job };
  }

  if (!current.submission.attemptedAt && outcome.status === "login-required") {
    if (!quiet) console.error("Login required. Authenticate in the dedicated Chrome profile, then retry.");
    return { job: current, exit: EXIT_LOGIN_REQUIRED };
  }
  const mapped = outcome.status === "validation-error"
    ? { status: "failed" as const, code: "validation-error", message: "Suno rejected the job fields. Review the generation options.", exit: EXIT_VALIDATION }
    : outcome.status === "rate-limited"
      ? { status: "failed" as const, code: "rate-limited", message: "Suno visibly rate limited this submission. Review account limits.", exit: EXIT_RATE_LIMITED }
      : outcome.status === "account-blocked"
        ? { status: "blocked" as const, code: "account-blocked", message: "Suno visibly blocked this account. Stop and review the account before recovery.", exit: EXIT_BLOCKED }
        : outcome.status === "login-required"
          ? { status: "blocked" as const, code: "login-required", message: "Sign in within the visible browser, then rerun this job.", exit: EXIT_BLOCKED }
          : { status: "unknown" as const, code: "submission-unknown", message: "Submission was not confirmed. Inspect the visible browser; this job will not click Create again.", exit: EXIT_CHANGED_UI };
  const job = transitionJob(current, mapped.status, new Date(), { code: mapped.code, message: mapped.message });
  await saveTrackedJob(paths, job);
  if (!quiet) console.error(`Job ${job.id}: ${mapped.message}`);
  return { job, exit: mapped.exit };
}

function applyObservation(job: TrackedJob, observation: CompletionObservation, attempt: number): TrackedJob {
  const updated = { ...job, observationAttempts: attempt };
  return transitionJob(
    updated,
    observation.status,
    new Date(),
    "error" in observation ? observation.error : undefined,
  );
}

function reportTrackedJob(job: TrackedJob, quiet = false): number {
  if (job.status === "completed") {
    if (!quiet) {
      console.log(`Job ${job.id} completed.`);
      for (const output of job.outputs) if (output.outputPath) console.log(`Output: ${output.outputPath}`);
    }
    return 0;
  }
  const message = job.error?.message ?? "Rerun the job to continue tracking.";
  if (!quiet) console.error(`Job ${job.id} is ${job.status}: ${message}`);
  if (job.status === "failed") return EXIT_FAILED;
  if (job.status === "blocked") return EXIT_BLOCKED;
  if (job.status === "unknown") return EXIT_UNKNOWN;
  return EXIT_BROWSER;
}

function reportSessionJob(job: TrackedJob, stage: DiagnosticStage, dependencies: SessionDependencies): number {
  const exit = reportTrackedJob(job, dependencies.quiet);
  return exit === 0 ? exit : sessionFailure(exit, stage, diagnosticCategory(exit, job), dependencies);
}

function sessionFailure(
  exit: number,
  stage: DiagnosticStage,
  category: DiagnosticCategory,
  dependencies: SessionDependencies,
): number {
  try { dependencies.onDiagnostic?.({ stage, category }); } catch { /* Diagnostics must not replace the job outcome. */ }
  return exit;
}

function queueResult(exitCode: number, job: TrackedJob): QueueJobResult {
  const submissionAttempted = Boolean(job.submission.attemptedAt);
  if (exitCode === 0) return { status: "completed", exitCode, submissionAttempted };
  if (job.error?.code === "account-blocked") return { status: "account-blocked", exitCode, category: "account-block", submissionAttempted };
  if (exitCode === EXIT_LOGIN_REQUIRED) return { status: "login-required", exitCode, category: "login", submissionAttempted };
  if (exitCode === EXIT_RATE_LIMITED) return { status: "rate-limited", exitCode, category: "rate-limit", submissionAttempted };
  if (exitCode === EXIT_VALIDATION) return { status: "validation-rejected", exitCode, category: "validation", submissionAttempted };
  if (exitCode === EXIT_CHANGED_UI) return { status: "changed-ui", exitCode, category: "changed-ui", submissionAttempted };
  if (exitCode === EXIT_BROWSER && !submissionAttempted) return { status: "browser-failed", exitCode, category: "browser-failure", submissionAttempted };
  if (job.status === "blocked") return { status: "blocked", exitCode, category: job.error?.code === "challenge-required" ? "challenge" : "login", submissionAttempted };
  if (job.status === "failed") return { status: "failed", exitCode, category: "failed", submissionAttempted };
  return { status: "unknown", exitCode: Math.max(exitCode, EXIT_UNKNOWN), category: "ambiguous", submissionAttempted };
}

function diagnosticStage(exitCode: number): DiagnosticStage {
  if (exitCode === EXIT_LOGIN_REQUIRED) return "preparation";
  if ([EXIT_VALIDATION, EXIT_RATE_LIMITED, EXIT_CHANGED_UI, EXIT_BLOCKED].includes(exitCode)) return "submission";
  if (exitCode === EXIT_BROWSER) return "navigation";
  return "observation";
}

function diagnosticCategory(exitCode: number, job: TrackedJob) {
  if (job.error?.code) return mapDiagnosticCategory(job.error.code);
  if (exitCode === EXIT_LOGIN_REQUIRED) return "login-required" as const;
  if (exitCode === EXIT_BROWSER) return "navigation-failed" as const;
  if (exitCode === EXIT_VALIDATION) return "validation-rejected" as const;
  if (exitCode === EXIT_RATE_LIMITED) return "rate-limited" as const;
  if (exitCode === EXIT_CHANGED_UI) return "changed-ui" as const;
  return "unexpected" as const;
}

function diagnosticCategoryForQueue(result: QueueJobResult) {
  if (result.status === "browser-failed") return "browser-unavailable" as const;
  if (result.status === "login-required") return "login-required" as const;
  if (result.status === "rate-limited") return "rate-limited" as const;
  if (result.status === "account-blocked") return "account-blocked" as const;
  if (result.status === "changed-ui") return "changed-ui" as const;
  if (result.status === "validation-rejected") return "validation-rejected" as const;
  if (result.status === "unknown") return "ambiguous-result" as const;
  if (result.status === "failed") return "observation-failed" as const;
  if (result.category === "challenge") return "challenge-required" as const;
  return "unexpected" as const;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
