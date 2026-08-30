import type { Locator, Page } from "playwright";
import { ACTION_TIMEOUT_MS, RESULT_TIMEOUT_MS, SUNO_CREATE_URL, SUNO_ORIGIN } from "../config.js";
import type { SunoJob } from "../domain/job.js";
import {
  challengeLocators,
  createFormLocators,
  createStructureLocators,
  isLoginUrl,
  loginLocators,
  LYRICS_PROMPT,
  type CreateStructureLocators,
} from "./selectors.js";

export { challengeLocators, createStructureLocators, loginLocators, LYRICS_PROMPT, type CreateStructureLocators } from "./selectors.js";

export type SunoNavigation = Readonly<{ createUrl: string; expectedOrigin: string }>;
export type PreparationOutcome = Readonly<{ status: "ready" | "login-required" | "changed-ui"; challengePaused: boolean }>;

const DEFAULT_NAVIGATION: SunoNavigation = { createUrl: SUNO_CREATE_URL, expectedOrigin: SUNO_ORIGIN };

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

type EntryState = "ready" | "login-required" | "challenge" | "changed-ui";

const classifyEntryState = async (page: Page, expectedUrl: URL, expectedOrigin: string): Promise<EntryState> => {
  const advanced = createFormLocators(page).advanced;
  const login = loginLocators(page);
  const challenge = challengeLocators(page);
  let firstState: Exclude<EntryState, "changed-ui">;
  try {
    firstState = await Promise.any([
      ...login.map((locator) => waitForEntryVisible(locator, "login-required")),
      ...challenge.map((locator) => waitForEntryVisible(locator, "challenge")),
      waitForEntryVisible(advanced, "ready"),
    ]) as Exclude<EntryState, "changed-ui">;
  } catch {
    return "changed-ui";
  }
  if (firstState === "ready") {
    await Promise.any([
      ...login.map((locator) => waitForVisible(locator, "login-required")),
      ...challenge.map((locator) => waitForVisible(locator, "challenge")),
    ]).catch(() => undefined);
  }
  const url = new URL(page.url());
  const loginVisible = isLoginUrl(url) || await firstVisible(login);
  const challengeVisible = await firstVisible(challenge);
  const readyVisible = await advanced.first().isVisible();
  if (url.origin !== expectedOrigin || (url.pathname !== expectedUrl.pathname && !loginVisible)) return "changed-ui";
  if (loginVisible) return "login-required";
  if (challengeVisible) return "challenge";
  return readyVisible ? "ready" : "changed-ui";
};

const fillForm = async (page: Page, job: SunoJob): Promise<void> => {
  const form = createFormLocators(page);
  await form.advanced.click();
  await form.moreOptions.click();
  if (job.options.instrumental) {
    await form.instrumental.setChecked(true);
    await form.style.fill([job.prompt, job.options.style].filter(Boolean).join(", "));
  } else {
    await form.promptMode.setChecked(true);
    await form.lyrics.fill(job.prompt);
    if (job.options.style !== undefined) await form.style.fill(job.options.style);
  }
  if (job.options.model !== undefined) {
    await form.modelButton.click();
    const model = form.modelOption(job.options.model);
    if ((await model.count()) !== 1) throw new Error("model control changed");
    await model.click();
  }
};

export const prepareSunoJob = async (
  page: Page,
  job: SunoJob,
  waitForChallengeContinue: () => Promise<void>,
  navigation: SunoNavigation = DEFAULT_NAVIGATION,
): Promise<PreparationOutcome> => {
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  let challengePaused = false;
  try {
    const expectedUrl = new URL(navigation.createUrl);
    await page.goto(expectedUrl.href, { waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT_MS });
    let entryState = await classifyEntryState(page, expectedUrl, navigation.expectedOrigin);
    if (entryState === "login-required") return { status: "login-required", challengePaused };
    if (entryState === "challenge") {
      challengePaused = true;
      await waitForChallengeContinue();
      entryState = await classifyEntryState(page, expectedUrl, navigation.expectedOrigin);
      if (entryState === "login-required") return { status: "login-required", challengePaused };
    }
    if (entryState !== "ready") return { status: "changed-ui", challengePaused };
    await fillForm(page, job);
    return { status: "ready", challengePaused };
  } catch {
    return { status: "changed-ui", challengePaused };
  }
};
