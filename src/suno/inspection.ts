import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { ACTION_TIMEOUT_MS, SUNO_CREATE_URL, SUNO_ORIGIN } from "../config.js";
import type { SunoJob } from "../domain/job.js";
import { createDiagnostic, writeDiagnostic, type RedactedDiagnostic } from "./diagnostics.js";
import { challengeLocators, createFormLocators, isLoginUrl, loginLocators } from "./selectors.js";

export interface SmokeArtifacts {
  root: string;
  screenshot: string;
  outcome: string;
}

export interface InspectionNavigation { createUrl: string; expectedOrigin: string }
export interface LiveSmokeOutcome {
  status: "ready" | "login-required" | "challenge-required" | "changed-ui";
  challengePaused: boolean;
  submitted: false;
  creditsConsumed: false;
  screenshot: string;
  diagnostic: RedactedDiagnostic;
}

const defaults: InspectionNavigation = { createUrl: SUNO_CREATE_URL, expectedOrigin: SUNO_ORIGIN };

export async function runLiveSmoke(
  page: Page,
  _job: SunoJob,
  _waitForChallengeContinue: () => Promise<void>,
  artifacts: SmokeArtifacts,
  navigation: InspectionNavigation = defaults,
): Promise<LiveSmokeOutcome> {
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  await page.goto(navigation.createUrl, { waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT_MS });
  let url = new URL(page.url());
  if (url.origin === navigation.expectedOrigin && !isLoginUrl(url)) {
    await waitForVisible([...loginLocators(page), ...challengeLocators(page), createFormLocators(page).advanced]);
    url = new URL(page.url());
  }
  const loginVisible = isLoginUrl(url) || await anyVisible(loginLocators(page));
  const challengeVisible = await anyVisible(challengeLocators(page));
  const readyVisible = await createFormLocators(page).advanced.first().isVisible();
  const status = url.origin !== navigation.expectedOrigin
    ? "changed-ui"
    : loginVisible
      ? "login-required"
      : challengeVisible
        ? "challenge-required"
        : readyVisible ? "ready" : "changed-ui";
  const category = status === "ready" ? "structure-ready" : status;
  const diagnostic = await createDiagnostic(page, "smoke", "smoke", category);
  const outcome: LiveSmokeOutcome = {
    status,
    challengePaused: challengeVisible,
    submitted: false,
    creditsConsumed: false,
    screenshot: artifacts.screenshot,
    diagnostic,
  };
  await mkdir(path.dirname(artifacts.screenshot), { recursive: true, mode: 0o700 });
  await page.screenshot({ path: artifacts.screenshot });
  await writeDiagnostic(artifacts.root, artifacts.outcome, diagnostic);
  return outcome;
}

async function waitForVisible(locators: ReturnType<typeof loginLocators>): Promise<void> {
  await Promise.any(locators.map((locator) => locator.first().waitFor({ state: "visible" }))).catch(() => undefined);
}

async function anyVisible(locators: ReturnType<typeof loginLocators>): Promise<boolean> {
  for (const locator of locators) if (await locator.first().isVisible()) return true;
  return false;
}
