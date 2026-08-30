import type { BrowserContext, Page } from "playwright";
import type { AutomationOutcome, JobCheckpoint, OutputStore, SunoAutomation, SunoSession } from "../application/contracts.js";
import { DEFAULT_DOWNLOAD_LIMITS, DEFAULT_OBSERVATION_LIMITS, type RuntimePaths } from "../config.js";
import type { SunoJob, TrackedJob } from "../domain/job.js";
import { launchSunoBrowser, openSunoPage } from "./browser.js";
import { waitForChallengeContinue } from "../challenge.js";
import { downloadCompletedTracks, observeCompletion } from "./completion.js";
import { probeCreateStructure, SELECTOR_KEYS } from "./diagnostics.js";
import { submitSunoJob, type SubmissionOutcome } from "./submission.js";
import { classifySunoLocation } from "./selectors.js";

export class PlaywrightSunoAdapter implements SunoAutomation {
  constructor(
    private readonly paths: RuntimePaths,
    private readonly outputs: OutputStore,
    private readonly challengeContinue: () => Promise<void> = waitForChallengeContinue,
  ) {}

  async open(): Promise<SunoSession> {
    const browser = await launchSunoBrowser(this.paths);
    return new PlaywrightSunoSession(browser.context, browser.page, this.paths, this.outputs, this.challengeContinue);
  }
}

class PlaywrightSunoSession implements SunoSession {
  private firstPage: Page | undefined;

  constructor(
    private readonly context: BrowserContext,
    page: Page,
    private readonly paths: RuntimePaths,
    private readonly outputs: OutputStore,
    private readonly challengeContinue: () => Promise<void>,
  ) {
    this.firstPage = page;
  }

  async submit(job: SunoJob, checkpoint: () => Promise<void>): Promise<AutomationOutcome> {
    const page = await this.page();
    const outcome = await submitSunoJob(page, job, this.challengeContinue, undefined, { beforeClick: checkpoint });
    return mapSubmission(outcome, page);
  }

  async observe(job: TrackedJob, checkpoint: (value: JobCheckpoint) => Promise<TrackedJob>): Promise<AutomationOutcome> {
    const page = await this.page();
    if (!job.submission.receipt) return this.outcome(page, "unknown", "missing-submission-receipt", "observation");
    let current = job;
    const observation = await observeCompletion(
      page,
      job.submission.receipt,
      { ...DEFAULT_OBSERVATION_LIMITS, initialAttempts: job.observationAttempts },
      async (result, attempt) => {
        current = await checkpoint({ kind: "observation", attempt, status: result.status });
      },
    );
    if (observation.status !== "completed") {
      const status = observation.status === "blocked" ? "challenge-required" : observation.status === "failed" ? "failed" : "unknown";
      const code = "error" in observation ? observation.error.code : "observation-exhausted";
      return this.outcome(page, status, code, "observation");
    }
    const completed = await downloadCompletedTracks(
      page,
      this.paths.downloads,
      this.outputs,
      current,
      observation.tracks,
      DEFAULT_DOWNLOAD_LIMITS,
      async (updated) => { current = await checkpoint({ kind: "download", job: updated }); },
    );
    return this.outcome(page, completed.status === "completed" ? "completed" : "unknown", completed.error?.code, "download", completed.outputs);
  }

  async close(): Promise<void> {
    await this.context.close();
  }

  private async page(): Promise<Page> {
    const page = this.firstPage ?? await openSunoPage(this.context);
    this.firstPage = undefined;
    return page;
  }

  private async outcome(
    page: Page,
    status: AutomationOutcome["status"],
    code?: string,
    stage?: AutomationOutcome["stage"],
    outputs?: AutomationOutcome["outputs"],
  ): Promise<AutomationOutcome> {
    return {
      status,
      ...(code ? { code } : {}),
      ...(stage ? { stage } : {}),
      ...(outputs ? { outputs } : {}),
      location: classifySunoLocation(page.url()),
      facts: await diagnosticFacts(page),
    };
  }
}

async function mapSubmission(outcome: SubmissionOutcome, page: Page): Promise<AutomationOutcome> {
  const status: AutomationOutcome["status"] = outcome.status === "submitted"
    ? "accepted"
    : outcome.status === "validation-error"
      ? "validation-rejected"
      : outcome.status;
  return {
    status,
    ...(outcome.status === "submitted" && outcome.receipt ? { receipt: outcome.receipt } : {}),
    stage: "submission",
    location: classifySunoLocation(page.url()),
    facts: await diagnosticFacts(page),
  };
}

async function diagnosticFacts(page: Page): Promise<NonNullable<AutomationOutcome["facts"]>> {
  const selectors = await probeCreateStructure(page);
  return SELECTOR_KEYS.map((key) => ({ key, ...selectors[key] }));
}
