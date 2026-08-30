import type { Locator, Page } from "playwright";
import type { SunoJob } from "../domain/job.js";
import type { ReceiptItem, SubmissionReceipt } from "../domain/job.js";
import { firstVisible, prepareSunoJob, waitForVisible, type SunoNavigation } from "./preparation.js";
import {
  challengeLocators,
  createFormLocators,
  loginLocators,
  resultContainers,
  submissionResultLocators,
  titleLocators,
} from "./selectors.js";

export type SubmissionOutcome =
  | { status: "submitted"; receipt?: SubmissionReceipt }
  | { status: "login-required" }
  | { status: "validation-error" }
  | { status: "rate-limited" }
  | { status: "account-blocked" }
  | { status: "changed-ui" };

export interface SubmissionHooks {
  beforeClick(): Promise<void>;
}

const waitForResult = async (page: Page, submittedClip: Locator): Promise<string> => {
  const challenge = challengeLocators(page).map((locator) =>
    waitForVisible(locator, "challenge"),
  );
  const outcomes = submissionResultLocators(page);
  return Promise.any([
    waitForVisible(submittedClip, "submitted"),
    ...outcomes.success.map((locator) => waitForVisible(locator, "submitted")),
    ...outcomes.validation.map((locator) => waitForVisible(locator, "validation-error")),
    ...outcomes.accountBlocked.map((locator) => waitForVisible(locator, "account-blocked")),
    ...outcomes.rateLimited.map((locator) => waitForVisible(locator, "rate-limited")),
    ...loginLocators(page).map((locator) => waitForVisible(locator, "login-required")),
    ...challenge,
  ]);
};

const submissionReceipt = async (page: Page, firstNewIndex: number): Promise<SubmissionReceipt | undefined> => {
  const containers = resultContainers(page);
  const items: ReceiptItem[] = [];
  const count = Math.min(await containers.count(), firstNewIndex + 4);
  for (let index = firstNewIndex; index < count; index += 1) {
    const container = containers.nth(index);
    if (!(await container.isVisible())) continue;
    const testId = cleanIdentity(await container.getAttribute("data-testid"));
    const visibleId = cleanIdentity(await container.getAttribute("aria-label"));
    const { heading, link } = titleLocators(container);
    const title = cleanIdentity(await (await heading.isVisible() ? heading : link).textContent());
    const item = { ...(testId ? { testId } : {}), ...(title ? { title } : {}), ...(visibleId ? { visibleId } : {}) };
    if (testId || title || visibleId) items.push(item);
  }
  return items.length > 0 ? { items } : undefined;
};

const cleanIdentity = (value: string | null): string | undefined => {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 500) : undefined;
};

export const submitSunoJob = async (
  page: Page,
  job: SunoJob,
  waitForChallengeContinue: () => Promise<void>,
  navigation?: SunoNavigation,
  hooks?: SubmissionHooks,
): Promise<SubmissionOutcome> => {
  const preparation = await prepareSunoJob(page, job, waitForChallengeContinue, navigation);
  if (preparation.status !== "ready") return { status: preparation.status };

  let submittedClip: Locator;
  let firstNewIndex: number;
  try {
    const clips = resultContainers(page);
    firstNewIndex = await clips.count();
    submittedClip = clips.nth(firstNewIndex);
    await hooks?.beforeClick();
    await createFormLocators(page).create.click();
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

  if (result === "submitted") {
    await submittedClip.waitFor({ state: "visible", timeout: 2_000 }).catch(() => undefined);
    const receipt = await submissionReceipt(page, firstNewIndex);
    return { status: "submitted", ...(receipt ? { receipt } : {}) };
  }
  if (result === "login-required") return { status: "login-required" };
  if (result === "validation-error") return { status: "validation-error" };
  if (result === "rate-limited") return { status: "rate-limited" };
  if (result === "account-blocked") return { status: "account-blocked" };
  return { status: "changed-ui" };
};
