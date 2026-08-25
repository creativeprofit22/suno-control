import type { Locator, Page } from "playwright";
import type { SunoJob } from "./job.js";

export type SubmissionOutcome =
  | { status: "submitted" }
  | { status: "login-required" }
  | { status: "validation-error" }
  | { status: "rate-limited" }
  | { status: "changed-ui" };

const DEFAULT_NAVIGATION = {
  createUrl: "https://suno.com/create",
  expectedOrigin: "https://suno.com",
};
const ACTION_TIMEOUT_MS = 10_000;
const RESULT_TIMEOUT_MS = 5_000;
const LYRICS_PROMPT =
  "What do you want your lyrics to be about? Suno will write new lyrics every generation. Leave this blank for a random topic.";

const firstVisible = async (locators: Locator[]): Promise<boolean> => {
  for (const locator of locators) {
    if (await locator.first().isVisible()) return true;
  }
  return false;
};

const loginLocators = (page: Page): Locator[] => [
  page.getByRole("button", { name: /^(log|sign) in$/i }),
  page.getByRole("link", { name: /^(log|sign) in$/i }),
  page.getByTestId("login-required"),
];

const challengeLocators = (page: Page): Locator[] => [
  page.getByTestId("interactive-challenge"),
  page.getByRole("dialog", { name: /captcha|security check|verify.*human/i }),
  page.locator('iframe[title*="captcha" i], iframe[title*="challenge" i]'),
];

const waitForVisible = async (locator: Locator, status: string): Promise<string> => {
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

const waitForResult = async (page: Page, submittedClip: Locator): Promise<string> => {
  const challenge = challengeLocators(page).map((locator) =>
    waitForVisible(locator, "challenge"),
  );
  return Promise.any([
    waitForVisible(submittedClip, "submitted"),
    waitForVisible(page.getByTestId("submission-success"), "submitted"),
    waitForVisible(
      page.getByRole("status", { name: /creating|queued|submitted/i }),
      "submitted",
    ),
    waitForVisible(page.getByTestId("validation-error"), "validation-error"),
    waitForVisible(
      page.getByRole("alert").filter({ hasText: /required|invalid|too long|validation/i }),
      "validation-error",
    ),
    waitForVisible(page.getByTestId("rate-limited"), "rate-limited"),
    waitForVisible(
      page.getByRole("alert").filter({ hasText: /rate limit|too many|try again later/i }),
      "rate-limited",
    ),
    ...loginLocators(page).map((locator) => waitForVisible(locator, "login-required")),
    ...challenge,
  ]);
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

export const submitSunoJob = async (
  page: Page,
  job: SunoJob,
  waitForChallengeContinue: () => Promise<void>,
  navigation: Readonly<{ createUrl: string; expectedOrigin: string }> = DEFAULT_NAVIGATION,
): Promise<SubmissionOutcome> => {
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  try {
    const expectedUrl = new URL(navigation.createUrl);
    await page.goto(expectedUrl.href, { waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT_MS });
    let entryState = await classifyEntryState(
      page,
      expectedUrl,
      navigation.expectedOrigin,
    );
    if (entryState === "login-required") return { status: "login-required" };
    if (entryState === "challenge") {
      await waitForChallengeContinue();
      entryState = await classifyEntryState(page, expectedUrl, navigation.expectedOrigin);
      if (entryState === "login-required") return { status: "login-required" };
    }
    if (entryState !== "ready") return { status: "changed-ui" };
  } catch {
    return { status: "changed-ui" };
  }

  let submittedClip: Locator;
  try {
    await fillForm(page, job);
    const clips = page.getByRole("table").getByRole("group");
    submittedClip = clips.nth(await clips.count());
    await page.getByRole("button", { name: "Create song", exact: true }).click();
  } catch {
    return { status: "changed-ui" };
  }

  let result: string;
  try {
    result = await waitForResult(page, submittedClip);
  } catch {
    return { status: "changed-ui" };
  }

  if (result === "challenge") {
    await waitForChallengeContinue();
    if (await firstVisible(challengeLocators(page))) return { status: "changed-ui" };
    try {
      result = await waitForResult(page, submittedClip);
    } catch {
      return { status: "changed-ui" };
    }
  }

  if (result === "submitted") return { status: "submitted" };
  if (result === "login-required") return { status: "login-required" };
  if (result === "validation-error") return { status: "validation-error" };
  if (result === "rate-limited") return { status: "rate-limited" };
  return { status: "changed-ui" };
};
