import { setTimeout as delay } from "node:timers/promises";
import type { Locator, Page } from "playwright";
import { ACTION_TIMEOUT_MS } from "../config.js";
import type { SunoJob } from "../domain/job.js";
import { createFormControls } from "./form-controls.js";
import {
  classifyCreatePageEntry,
  DEFAULT_SUNO_NAVIGATION,
  type CreatePageEntryState,
  type SunoNavigation,
} from "./page-state.js";

export const ASSIST_ACTION_DELAY_MS = 1_000;
export const ASSIST_CHARACTER_DELAY_MS = 75;

export type AssistanceOutcome = Readonly<{
  status: "ready-for-review" | "login-required" | "challenge-required" | "changed-ui";
}>;
export type ManualGate = "login" | "challenge";
export type AssistanceSleeper = (milliseconds: number) => Promise<void>;

type ClickControl = Pick<Locator, "click" | "count" | "isVisible">;
type TextControl = Pick<Locator, "fill" | "count" | "isVisible">;

export interface AssistedFormControls {
  advanced: ClickControl;
  moreOptions: ClickControl;
  style: TextControl;
  instrumental: ClickControl;
  promptMode: ClickControl;
  lyrics: TextControl;
  modelButton: ClickControl;
  modelOption(name: string): ClickControl;
}

const selectedMode = (controls: AssistedFormControls, job: SunoJob): ClickControl =>
  job.options.instrumental ? controls.instrumental : controls.promptMode;

const requiredControls = (controls: AssistedFormControls, job: SunoJob): Array<ClickControl | TextControl> => [
  selectedMode(controls, job),
  job.options.instrumental ? controls.style : controls.lyrics,
  ...(!job.options.instrumental && job.options.style !== undefined ? [controls.style] : []),
  ...(job.options.model !== undefined ? [controls.modelButton] : []),
];

const controlsAreReady = async (controls: AssistedFormControls, job: SunoJob): Promise<boolean> => {
  for (const control of requiredControls(controls, job)) {
    if ((await control.count()) !== 1 || !(await control.isVisible())) return false;
  }
  return true;
};

export async function fillAssistedSunoForm(
  controls: AssistedFormControls,
  job: SunoJob,
  sleep: AssistanceSleeper = delay,
): Promise<boolean> {
  let actionStarted = false;
  const act = async (action: () => Promise<void>): Promise<void> => {
    if (actionStarted) await sleep(ASSIST_ACTION_DELAY_MS);
    actionStarted = true;
    await action();
  };
  const fillProgressively = async (control: TextControl, value: string): Promise<void> => {
    await act(async () => {
      let prefix = "";
      for (const character of value) {
        prefix += character;
        await control.fill(prefix);
        await sleep(ASSIST_CHARACTER_DELAY_MS);
      }
    });
  };

  await act(() => controls.advanced.click());
  await act(() => controls.moreOptions.click());
  const mode = selectedMode(controls, job);
  if ((await mode.count()) !== 1 || !(await mode.isVisible())) return false;
  await act(() => mode.click());
  if (!await controlsAreReady(controls, job)) return false;

  if (job.options.model !== undefined) {
    await act(() => controls.modelButton.click());
    const model = controls.modelOption(job.options.model);
    if ((await model.count()) !== 1 || !(await model.isVisible())) return false;
    await act(() => model.click());
  }
  if (job.options.instrumental) {
    await fillProgressively(controls.style, [job.prompt, job.options.style].filter(Boolean).join(", "));
  } else {
    await fillProgressively(controls.lyrics, job.prompt);
    if (job.options.style !== undefined) await fillProgressively(controls.style, job.options.style);
  }
  return true;
}

const gateFor = (state: CreatePageEntryState): ManualGate | undefined => {
  if (state === "login-required") return "login";
  if (state === "challenge") return "challenge";
  return undefined;
};

const outcomeFor = (state: CreatePageEntryState): AssistanceOutcome => {
  if (state === "login-required") return { status: "login-required" };
  if (state === "challenge") return { status: "challenge-required" };
  return { status: "changed-ui" };
};

export async function prepareAssistedSunoJob(
  page: Page,
  job: SunoJob,
  waitForManualContinue: (gate: ManualGate) => Promise<void>,
  navigation: SunoNavigation = DEFAULT_SUNO_NAVIGATION,
  sleep: AssistanceSleeper = delay,
): Promise<AssistanceOutcome> {
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  let expectedUrl: URL;
  try {
    expectedUrl = new URL(navigation.createUrl);
  } catch {
    return { status: "changed-ui" };
  }
  if (expectedUrl.origin !== navigation.expectedOrigin) return { status: "changed-ui" };
  await page.goto(expectedUrl.href, { waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT_MS });

  try {
    let entryState = await classifyCreatePageEntry(page, expectedUrl, navigation.expectedOrigin);
    const gate = gateFor(entryState);
    if (gate !== undefined) {
      await waitForManualContinue(gate);
      entryState = await classifyCreatePageEntry(page, expectedUrl, navigation.expectedOrigin);
    }
    if (entryState !== "ready") return outcomeFor(entryState);
    const ready = await fillAssistedSunoForm(createFormControls(page), job, sleep);
    return ready ? { status: "ready-for-review" } : { status: "changed-ui" };
  } catch {
    return { status: "changed-ui" };
  }
}
