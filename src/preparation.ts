import type { Locator, Page } from "playwright";
import type { SunoJob } from "./job.js";

export type SunoNavigation = Readonly<{ createUrl: string; expectedOrigin: string }>;
export type PreparationOutcome = Readonly<{
  status: "ready" | "login-required" | "changed-ui";
  challengePaused: boolean;
}>;

const DEFAULT_NAVIGATION: SunoNavigation = {
  createUrl: "https://suno.com/create",
  expectedOrigin: "https://suno.com",
};
const ACTION_TIMEOUT_MS = 10_000;
const RESULT_TIMEOUT_MS = 5_000;
export const LYRICS_PROMPT =
  "What do you want your lyrics to be about? Suno will write new lyrics every generation. Leave this blank for a random topic.";

export const firstVisible = async (locators: Locator[]): Promise<boolean> => {
  for (const locator of locators) {
    if (await locator.first().isVisible()) return true;
  }
  return false;
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

export interface CreateStructureLocators {
  advancedTab: Locator;
  moreOptions: Locator;
  lyricsPrompt: Locator;
  stylePrompt: Locator;
  instrumentalMode: Locator;
  createButton: Locator;
  loginMarker: Locator;
  challengeMarker: Locator;
  resultContainer: Locator;
  downloadControl: Locator;
}

export const createStructureLocators = (page: Page): CreateStructureLocators => ({
  advancedTab: page.getByRole("tab", { name: "Advanced", exact: true }),
  moreOptions: page.getByRole("button", { name: "More Options", exact: true }),
  lyricsPrompt: page.getByRole("textbox", { name: LYRICS_PROMPT, exact: true }),
  stylePrompt: page.locator('textarea[maxlength="1000"]'),
  instrumentalMode: page.getByRole("radio", { name: "Instrumental", exact: true }),
  createButton: page.getByRole("button", { name: "Create song", exact: true }),
  loginMarker: loginLocators(page).reduce((combined, locator) => combined.or(locator)),
  challengeMarker: challengeLocators(page).reduce((combined, locator) => combined.or(locator)),
  resultContainer: page.getByRole("table").getByRole("group"),
  downloadControl: page.getByRole("button", { name: /^download(?: audio)?$/i }).or(
    page.getByRole("link", { name: /^download(?: audio)?$/i }),
  ),
});

export const waitForVisible = async (locator: Locator, status: string): Promise<string> => {
  await locator.first().waitFor({ state: "visible", timeout: RESULT_TIMEOUT_MS });
  return status;
};

const waitForEntryVisible = async (locator: Locator, status: string): Promise<string> => {
  await locator.first().waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
  return status;
};

type EntryState = "ready" | "login-required" | "challenge" | "changed-ui";

const isLoginUrl = (url: URL): boolean =>
  /\/(?:sign-?in|sign-?up|login)(?:\/|$)/.test(url.pathname.toLowerCase());

const classifyEntryState = async (
  page: Page,
  expectedUrl: URL,
  expectedOrigin: string,
): Promise<EntryState> => {
  const advanced = page.getByRole("tab", { name: "Advanced", exact: true });
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

  if (url.origin !== expectedOrigin) return "changed-ui";
  if (url.pathname !== expectedUrl.pathname && !loginVisible) return "changed-ui";
  if (loginVisible) return "login-required";
  if (challengeVisible) return "challenge";
  return readyVisible ? "ready" : "changed-ui";
};

const fillForm = async (page: Page, job: SunoJob): Promise<void> => {
  await page.getByRole("tab", { name: "Advanced", exact: true }).click();
  await page.getByRole("button", { name: "More Options", exact: true }).click();

  const style = page.locator('textarea[maxlength="1000"]');
  if (job.options.instrumental) {
    await page.getByRole("radio", { name: "Instrumental", exact: true }).setChecked(true);
    await style.fill([job.prompt, job.options.style].filter(Boolean).join(", "));
  } else {
    await page.getByRole("radio", { name: "Prompt", exact: true }).setChecked(true);
    await page.getByRole("textbox", { name: LYRICS_PROMPT, exact: true }).fill(job.prompt);
    if (job.options.style !== undefined) await style.fill(job.options.style);
  }

  if (job.options.model !== undefined) {
    const modelButton = page.getByRole("button", { name: /^v\d/i }).first();
    await modelButton.click();
    const model = page.getByRole("menu").getByText(job.options.model, { exact: true });
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
