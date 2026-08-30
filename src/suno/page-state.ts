import type { Locator, Page } from "playwright";
import { ACTION_TIMEOUT_MS, RESULT_TIMEOUT_MS, SUNO_CREATE_URL, SUNO_ORIGIN } from "../config.js";
import { createFormControls } from "./form-controls.js";

export type SunoNavigation = Readonly<{ createUrl: string; expectedOrigin: string }>;
export type CreatePageEntryState = "ready" | "login-required" | "challenge" | "changed-ui";
export type SunoLocation = "suno-create" | "suno-login" | "suno-other" | "external" | "unknown";

export const DEFAULT_SUNO_NAVIGATION: SunoNavigation = {
  createUrl: SUNO_CREATE_URL,
  expectedOrigin: SUNO_ORIGIN,
};

export const loginLocators = (page: Page): Locator[] => [
  page.getByRole("button", { name: /^(log|sign) in$/i }),
  page.getByRole("link", { name: /^(log|sign) in$/i }),
  page.getByTestId("login-required"),
];

export const challengeLocators = (page: Page): Locator[] => [
  page.getByTestId("interactive-challenge"),
  page.getByRole("dialog", { name: /captcha|security check|verify.*human/i }),
  page.locator('iframe[title*="captcha" i], iframe[title*="challenge" i]'),
];

export const firstVisible = async (locators: Locator[]): Promise<boolean> => {
  for (const locator of locators) if (await locator.first().isVisible()) return true;
  return false;
};

export const waitForVisible = async (locator: Locator, status: string): Promise<string> => {
  await locator.first().waitFor({ state: "visible", timeout: RESULT_TIMEOUT_MS });
  return status;
};

const waitForEntryVisible = async (locator: Locator, status: string): Promise<string> => {
  await locator.first().waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
  return status;
};
const ENTRY_POLL_INTERVAL_MS = 100;
const ENTRY_POLL_TIMEOUT_MS = 2_000;
const REQUIRED_STABLE_SAMPLES = 2;

export const classifyCreatePageEntry = async (
  page: Page,
  expectedUrl: URL,
  expectedOrigin: string,
): Promise<CreatePageEntryState> => {
  const advanced = createFormControls(page).advanced;
  const login = loginLocators(page);
  const challenge = challengeLocators(page);
  let firstState: Exclude<CreatePageEntryState, "changed-ui">;
  try {
    firstState = await Promise.any([
      ...login.map((locator) => waitForEntryVisible(locator, "login-required")),
      ...challenge.map((locator) => waitForEntryVisible(locator, "challenge")),
      waitForEntryVisible(advanced, "ready"),
    ]) as Exclude<CreatePageEntryState, "changed-ui">;
  } catch {
    return stableEntryState(page, expectedUrl, expectedOrigin, login, challenge, advanced);
  }
  if (firstState === "ready") {
    await Promise.any([
      ...login.map((locator) => waitForVisible(locator, "login-required")),
      ...challenge.map((locator) => waitForVisible(locator, "challenge")),
    ]).catch(() => undefined);
  }
  return stableEntryState(page, expectedUrl, expectedOrigin, login, challenge, advanced);
};

async function stableEntryState(
  page: Page,
  expectedUrl: URL,
  expectedOrigin: string,
  login: Locator[],
  challenge: Locator[],
  advanced: Locator,
): Promise<CreatePageEntryState> {
  const deadline = Date.now() + ENTRY_POLL_TIMEOUT_MS;
  let previous: CreatePageEntryState | undefined;
  let stableSamples = 0;

  while (Date.now() <= deadline) {
    const state = await visibleEntryState(page, expectedUrl, expectedOrigin, login, challenge, advanced);
    if (state === "changed-ui") {
      previous = undefined;
      stableSamples = 0;
      if (new URL(page.url()).origin !== expectedOrigin) return state;
    } else {
      stableSamples = state === previous ? stableSamples + 1 : 1;
      previous = state;
      if (stableSamples >= REQUIRED_STABLE_SAMPLES) return state;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(ENTRY_POLL_INTERVAL_MS, remaining)));
  }
  return "changed-ui";
}

async function visibleEntryState(
  page: Page,
  expectedUrl: URL,
  expectedOrigin: string,
  login: Locator[],
  challenge: Locator[],
  advanced: Locator,
): Promise<CreatePageEntryState> {
  const url = new URL(page.url());
  const loginVisible = isLoginUrl(url) || await firstVisible(login);
  const challengeVisible = await firstVisible(challenge);
  const readyVisible = await advanced.first().isVisible();
  if (url.origin !== expectedOrigin || (url.pathname !== expectedUrl.pathname && !loginVisible)) return "changed-ui";
  if (loginVisible) return "login-required";
  if (challengeVisible) return "challenge";
  return readyVisible ? "ready" : "changed-ui";
}

export const isLoginUrl = (url: URL): boolean => /\/(?:sign-?in|sign-?up|login)(?:\/|$)/.test(url.pathname.toLowerCase());

export function classifySunoLocation(value: string): SunoLocation {
  try {
    const url = new URL(value);
    if (url.origin !== SUNO_ORIGIN) return "external";
    if (isLoginUrl(url)) return "suno-login";
    return url.pathname === "/create" ? "suno-create" : "suno-other";
  } catch {
    return "unknown";
  }
}
