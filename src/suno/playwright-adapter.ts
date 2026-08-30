import type { BrowserContext, Page } from "playwright";
import type { AutomationOutcome, OutputStore, SunoAutomation, SunoSession } from "../application/contracts.js";
import { DEFAULT_DOWNLOAD_LIMITS, DEFAULT_OBSERVATION_LIMITS, type RuntimePaths } from "../config.js";
import type { SunoJob, TrackedJob } from "../domain/job.js";
import type { LocalJobRepository } from "../persistence/local-job-repository.js";
import { launchSunoBrowser, openSunoPage } from "./browser.js";
import { waitForChallengeContinue } from "../challenge.js";
import { downloadCompletedTracks, observeCompletion } from "./completion.js";
import { submitSunoJob, type SubmissionOutcome } from "./submission.js";
import { classifySunoLocation } from "./selectors.js";

export class PlaywrightSunoAdapter implements SunoAutomation {
  constructor(
    private readonly paths: RuntimePaths,
    private readonly repository: LocalJobRepository,
    private readonly outputs: OutputStore,
    private readonly challengeContinue: () => Promise<void> = waitForChallengeContinue,
  ) {}

  async open(): Promise<SunoSession> {
    const browser = await launchSunoBrowser(this.paths);
    return new PlaywrightSunoSession(browser.context, browser.page, this.paths, this.repository, this.outputs, this.challengeContinue);
  }
}

class PlaywrightSunoSession implements SunoSession {
  private firstPage: Page | undefined;

  constructor(
    private readonly context: BrowserContext,
    page: Page,
    private readonly paths: RuntimePaths,
    private readonly repository: LocalJobRepository,
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

  async observe(job: TrackedJob): Promise<AutomationOutcome> {
    const page = await this.page();
    if (!job.submission.receipt) return this.outcome(page, "unknown", "missing-submission-receipt", "observation");
    const observation = await observeCompletion(
      page,
      job.submission.receipt,
      { ...DEFAULT_OBSERVATION_LIMITS, initialAttempts: job.observationAttempts },
      async () => undefined,
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
      job,
      observation.tracks,
      DEFAULT_DOWNLOAD_LIMITS,
      (updated) => this.repository.save(updated),
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

  private outcome(
    page: Page,
    status: AutomationOutcome["status"],
    code?: string,
    stage?: AutomationOutcome["stage"],
    outputs?: AutomationOutcome["outputs"],
  ): AutomationOutcome {
    return {
      status,
      ...(code ? { code } : {}),
      ...(stage ? { stage } : {}),
      ...(outputs ? { outputs } : {}),
      location: classifySunoLocation(page.url()),
    };
  }
}

function mapSubmission(outcome: SubmissionOutcome, page: Page): AutomationOutcome {
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
  };
}
