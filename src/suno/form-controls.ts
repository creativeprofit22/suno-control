import type { Locator, Page } from "playwright";

export const LYRICS_PROMPT =
  "What do you want your lyrics to be about? Suno will write new lyrics every generation. Leave this blank for a random topic.";

export interface SunoFormControls {
  advanced: Locator;
  moreOptions: Locator;
  style: Locator;
  instrumental: Locator;
  promptMode: Locator;
  lyrics: Locator;
  modelButton: Locator;
  modelOption(name: string): Locator;
}

export const createFormControls = (page: Page): SunoFormControls => ({
  advanced: page.getByRole("tab", { name: "Advanced", exact: true }),
  moreOptions: page.getByRole("button", { name: "More Options", exact: true }),
  style: page.locator('textarea[maxlength="1000"]'),
  instrumental: page.getByRole("radio", { name: "Instrumental", exact: true }),
  promptMode: page.getByRole("radio", { name: "Prompt", exact: true }),
  lyrics: page.getByPlaceholder(LYRICS_PROMPT, { exact: true })
    .or(page.getByRole("textbox", { name: LYRICS_PROMPT, exact: true })),
  modelButton: page.getByRole("button", { name: /^v\d/i }).first(),
  modelOption: (name: string) => page.getByRole("menu").getByText(name, { exact: true }),
});
