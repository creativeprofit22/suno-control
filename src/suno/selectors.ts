import type { Locator, Page } from "playwright";
import { SUNO_ORIGIN } from "../config.js";
import type { ReceiptItem } from "../domain/job.js";

export const LYRICS_PROMPT =
  "What do you want your lyrics to be about? Suno will write new lyrics every generation. Leave this blank for a random topic.";

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

export const createFormLocators = (page: Page) => ({
  advanced: page.getByRole("tab", { name: "Advanced", exact: true }),
  moreOptions: page.getByRole("button", { name: "More Options", exact: true }),
  style: page.locator('textarea[maxlength="1000"]'),
  instrumental: page.getByRole("radio", { name: "Instrumental", exact: true }),
  promptMode: page.getByRole("radio", { name: "Prompt", exact: true }),
  lyrics: page.getByRole("textbox", { name: LYRICS_PROMPT, exact: true }),
  modelButton: page.getByRole("button", { name: /^v\d/i }).first(),
  modelOption: (name: string) => page.getByRole("menu").getByText(name, { exact: true }),
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

export const isLoginUrl = (url: URL): boolean => /\/(?:sign-?in|sign-?up|login)(?:\/|$)/.test(url.pathname.toLowerCase());

export type SunoLocation = "suno-create" | "suno-login" | "suno-other" | "external" | "unknown";
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
