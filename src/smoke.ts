import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { createDiagnostic, writeDiagnostic, type RedactedDiagnostic } from "./diagnostics.js";
import type { SunoJob } from "./job.js";
import { prepareSunoJob, type PreparationOutcome, type SunoNavigation } from "./preparation.js";

export interface SmokeArtifacts {
  root: string;
  screenshot: string;
  outcome: string;
}

export interface LiveSmokeOutcome extends PreparationOutcome {
  submitted: false;
  screenshot: string;
  diagnostic: RedactedDiagnostic;
}

export async function runLiveSmoke(
  page: Page,
  job: SunoJob,
  waitForChallengeContinue: () => Promise<void>,
  artifacts: SmokeArtifacts,
  navigation?: SunoNavigation,
): Promise<LiveSmokeOutcome> {
  const preparation = await prepareSunoJob(page, job, waitForChallengeContinue, navigation);
  const category = preparation.status === "ready"
    ? "structure-ready"
    : preparation.status === "login-required"
      ? "login-required"
      : "changed-ui";
  const diagnostic = await createDiagnostic(page, "smoke", "smoke", category);
  const outcome: LiveSmokeOutcome = {
    ...preparation,
    submitted: false,
    screenshot: artifacts.screenshot,
    diagnostic,
  };

  await mkdir(path.dirname(artifacts.screenshot), { recursive: true, mode: 0o700 });
  await page.screenshot({ path: artifacts.screenshot });
  await writeDiagnostic(artifacts.root, artifacts.outcome, diagnostic);
  return outcome;
}
