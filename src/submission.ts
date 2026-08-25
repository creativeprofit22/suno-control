import type { Locator, Page } from "playwright";
import type { SunoJob } from "./job.js";
import {
  challengeLocators,
  firstVisible,
  loginLocators,
  prepareSunoJob,
  waitForVisible,
  type SunoNavigation,
} from "./preparation.js";

export type SubmissionOutcome =
  | { status: "submitted" }
  | { status: "login-required" }
  | { status: "validation-error" }
  | { status: "rate-limited" }
  | { status: "changed-ui" };

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

export const submitSunoJob = async (
  page: Page,
  job: SunoJob,
  waitForChallengeContinue: () => Promise<void>,
  navigation?: SunoNavigation,
): Promise<SubmissionOutcome> => {
  const preparation = await prepareSunoJob(page, job, waitForChallengeContinue, navigation);
  if (preparation.status !== "ready") return { status: preparation.status };

  let submittedClip: Locator;
  try {
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
