import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { ACTION_TIMEOUT_MS, SUNO_CREATE_URL, SUNO_ORIGIN } from "../config.js";
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
  waitForChallengeContinue: () => Promise<void>,
  artifacts: SmokeArtifacts,
  navigation: InspectionNavigation = defaults,
): Promise<LiveSmokeOutcome> {
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  await page.goto(navigation.createUrl, { waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT_MS });
  const url = new URL(page.url());
  if (url.origin === navigation.expectedOrigin && !isLoginUrl(url)) {
    await waitForVisible([...loginLocators(page), ...challengeLocators(page), createFormLocators(page).advanced]);
  }
  let status = await classifyState(page, navigation.expectedOrigin);
  let challengePaused = false;
  if (status === "challenge-required") {
    await waitForChallengeContinue();
    challengePaused = true;
    status = await classifyState(page, navigation.expectedOrigin);
  }
  const category = status === "ready" ? "structure-ready" : status;
  const diagnostic = await createDiagnostic(page, "smoke", "smoke", category);
  const outcome: LiveSmokeOutcome = {
    status,
    challengePaused,
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

async function classifyState(page: Page, expectedOrigin: string): Promise<LiveSmokeOutcome["status"]> {
  const url = new URL(page.url());
  if (url.origin !== expectedOrigin) return "changed-ui";
  if (isLoginUrl(url) || await anyVisible(loginLocators(page))) return "login-required";
  if (await anyVisible(challengeLocators(page))) return "challenge-required";
  return await createFormLocators(page).advanced.first().isVisible() ? "ready" : "changed-ui";
}

async function waitForVisible(locators: ReturnType<typeof loginLocators>): Promise<void> {
  await Promise.any(locators.map((locator) => locator.first().waitFor({ state: "visible" }))).catch(() => undefined);
}

async function anyVisible(locators: ReturnType<typeof loginLocators>): Promise<boolean> {
  for (const locator of locators) if (await locator.first().isVisible()) return true;
  return false;
}
