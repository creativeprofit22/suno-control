import type { Page } from "playwright";
import { ACTION_TIMEOUT_MS } from "../config.js";
import type { SunoJob } from "../domain/job.js";
import { createFormControls } from "./form-controls.js";
import {
  classifyCreatePageEntry,
  DEFAULT_SUNO_NAVIGATION,
  type SunoNavigation,
} from "./page-state.js";

export { LYRICS_PROMPT } from "./form-controls.js";
export {
  challengeLocators,
  firstVisible,
  loginLocators,
  waitForVisible,
  type SunoNavigation,
} from "./page-state.js";
export { createStructureLocators, type CreateStructureLocators } from "./selectors.js";

export type PreparationOutcome = Readonly<{ status: "ready" | "login-required" | "changed-ui"; challengePaused: boolean }>;

const fillForm = async (page: Page, job: SunoJob): Promise<void> => {
  const form = createFormControls(page);
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
  navigation: SunoNavigation = DEFAULT_SUNO_NAVIGATION,
): Promise<PreparationOutcome> => {
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  let challengePaused = false;
  try {
    const expectedUrl = new URL(navigation.createUrl);
    await page.goto(expectedUrl.href, { waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT_MS });
    let entryState = await classifyCreatePageEntry(page, expectedUrl, navigation.expectedOrigin);
    if (entryState === "login-required") return { status: "login-required", challengePaused };
    if (entryState === "challenge") {
      challengePaused = true;
      await waitForChallengeContinue();
      entryState = await classifyCreatePageEntry(page, expectedUrl, navigation.expectedOrigin);
      if (entryState === "login-required") return { status: "login-required", challengePaused };
    }
    if (entryState !== "ready") return { status: "changed-ui", challengePaused };
    await fillForm(page, job);
    return { status: "ready", challengePaused };
  } catch {
    return { status: "changed-ui", challengePaused };
  }
};
