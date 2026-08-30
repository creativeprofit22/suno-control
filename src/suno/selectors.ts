import type { Locator, Page } from "playwright";
import type { ReceiptItem } from "../domain/job.js";
import { createFormControls } from "./form-controls.js";
import { challengeLocators, classifySunoLocation, loginLocators } from "./page-state.js";

export { LYRICS_PROMPT } from "./form-controls.js";
export { challengeLocators, classifySunoLocation, isLoginUrl, loginLocators, type SunoLocation } from "./page-state.js";

export const SELECTOR_KEYS = [
  "advancedTab", "moreOptions", "lyricsPrompt", "stylePrompt", "instrumentalMode", "createButton",
  "loginMarker", "challengeMarker", "resultContainer", "downloadControl",
] as const;

export type SelectorKey = (typeof SELECTOR_KEYS)[number];

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

export const createFormLocators = (page: Page) => ({
  ...createFormControls(page),
  create: page.getByRole("button", { name: "Create song", exact: true }),
});

export const resultContainers = (page: Page): Locator => page.getByRole("table").getByRole("group");

export const downloadControl = (root: Page | Locator): Locator =>
  root.getByRole("button", { name: /^download(?: audio)?$/i }).or(root.getByRole("link", { name: /^download(?: audio)?$/i }));

export const createStructureLocators = (page: Page): CreateStructureLocators => {
  const form = createFormLocators(page);
  return {
    advancedTab: form.advanced,
    moreOptions: form.moreOptions,
    lyricsPrompt: form.lyrics,
    stylePrompt: form.style,
    instrumentalMode: form.instrumental,
    createButton: form.create,
    loginMarker: loginLocators(page).reduce((combined, locator) => combined.or(locator)),
    challengeMarker: challengeLocators(page).reduce((combined, locator) => combined.or(locator)),
    resultContainer: resultContainers(page),
    downloadControl: downloadControl(page),
  };
};

export const submissionResultLocators = (page: Page) => ({
  success: [page.getByTestId("submission-success"), page.getByRole("status", { name: /creating|queued|submitted/i })],
  validation: [page.getByTestId("validation-error"), page.getByRole("alert").filter({ hasText: /required|invalid|too long|validation/i })],
  accountBlocked: [page.getByTestId("account-blocked"), page.getByRole("alert").filter({ hasText: /account (?:blocked|disabled|suspended)|access (?:blocked|suspended)/i })],
  rateLimited: [page.getByTestId("rate-limited"), page.getByRole("alert").filter({ hasText: /rate limit|too many|try again later/i })],
});

export const trackStateLocators = (container: Locator) => ({
  failure: container.getByTestId("generation-failed").or(container.getByRole("alert").filter({ hasText: /failed|error|restricted|rate limit|not enough credits/i })),
  queued: container.getByRole("status").filter({ hasText: /queued|waiting|pending/i }),
  running: container.getByRole("status").filter({ hasText: /creating|generating|running/i }).or(container.getByRole("progressbar")),
  download: downloadControl(container),
});

export const receiptCandidate = (page: Page, item: ReceiptItem): Locator => {
  let candidate = resultContainers(page);
  if (item.testId) candidate = candidate.and(page.getByTestId(item.testId));
  if (item.visibleId) candidate = candidate.and(page.getByRole("group", { name: item.visibleId, exact: true }));
  if (item.title) {
    const title = page.getByRole("heading", { name: item.title, exact: true }).or(page.getByRole("link", { name: item.title, exact: true }));
    candidate = candidate.filter({ has: title });
  }
  return candidate;
};

export const titleLocators = (container: Locator) => ({
  heading: container.getByRole("heading").first(),
  link: container.getByRole("link").first(),
});
