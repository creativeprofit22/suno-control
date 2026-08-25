import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import type { SunoJob } from "./job.js";
import {
  prepareSunoJob,
  type PreparationOutcome,
  type SunoNavigation,
} from "./preparation.js";

export interface SmokeArtifacts {
  screenshot: string;
  outcome: string;
}

export interface LiveSmokeOutcome extends PreparationOutcome {
  submitted: false;
  screenshot: string;
}

export async function runLiveSmoke(
  page: Page,
  job: SunoJob,
  waitForChallengeContinue: () => Promise<void>,
  artifacts: SmokeArtifacts,
  navigation?: SunoNavigation,
): Promise<LiveSmokeOutcome> {
  const preparation = await prepareSunoJob(page, job, waitForChallengeContinue, navigation);
  const outcome: LiveSmokeOutcome = {
    ...preparation,
    submitted: false,
    screenshot: artifacts.screenshot,
  };

  await Promise.all([
    mkdir(path.dirname(artifacts.screenshot), { recursive: true }),
    mkdir(path.dirname(artifacts.outcome), { recursive: true }),
  ]);
  await page.screenshot({ path: artifacts.screenshot });
  await writeFile(artifacts.outcome, `${JSON.stringify(outcome, null, 2)}\n`, "utf8");
  return outcome;
}
