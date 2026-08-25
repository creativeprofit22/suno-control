import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("criterion 1: queued jobs use confirmed semantic Create controls", async () => {
  const [submission, preparation, cli, fixtures] = await Promise.all([
    read("src/submission.ts"),
    read("src/preparation.ts"),
    read("src/cli.ts"),
    read("test/submission.test.ts"),
  ]);
  assert.match(cli, /submit\(page, job, waitForChallenge\)/);
  assert.match(preparation, /getByRole\("tab", \{ name: "Advanced", exact: true \}\)/);
  assert.match(preparation, /getByRole\("textbox", \{ name: LYRICS_PROMPT, exact: true \}\)/);
  assert.match(preparation, /getByRole\("radio", \{ name: "Instrumental", exact: true \}\)/);
  assert.match(submission, /getByRole\("button", \{ name: "Create song", exact: true \}\)/);
  assert.match(fixtures, /fills semantic fields, selects the exact model, and submits once/);
});

test("criterion 2: submission relies on bounded locator waits and one click", async () => {
  const [submission, preparation, fixtures] = await Promise.all([
    read("src/submission.ts"),
    read("src/preparation.ts"),
    read("test/submission.test.ts"),
  ]);
  assert.match(preparation, /waitFor\(\{ state: "visible", timeout: RESULT_TIMEOUT_MS \}\)/);
  assert.match(submission, /Promise\.any/);
  assert.doesNotMatch(`${submission}\n${preparation}`, /waitForTimeout|\.mouse\.|\.keyboard\.type|force\s*:/i);
  assert.match(fixtures, /does not retry after an ambiguous post-click timeout/);
});

test("criterion 3: every required terminal state has a stable outcome", async () => {
  const [submission, preparation, cli] = await Promise.all([
    read("src/submission.ts"),
    read("src/preparation.ts"),
    read("src/cli.ts"),
  ]);
  for (const status of [
    "submitted",
    "login-required",
    "validation-error",
    "rate-limited",
    "changed-ui",
  ]) {
    assert.match(submission, new RegExp(`status: "${status}"`));
  }
  assert.match(preparation, /interactive-challenge/);
  assert.match(cli, /EXIT_VALIDATION = 5/);
  assert.match(cli, /EXIT_RATE_LIMITED = 6/);
  assert.match(cli, /EXIT_CHANGED_UI = 7/);
});

test("criterion 4: challenges pause for an explicit user continuation", async () => {
  const [submission, preparation, challenge, fixtures] = await Promise.all([
    read("src/submission.ts"),
    read("src/preparation.ts"),
    read("src/challenge.ts"),
    read("test/submission.test.ts"),
  ]);
  assert.match(`${submission}\n${preparation}`, /await waitForChallengeContinue\(\)/);
  assert.match(challenge, /Interactive challenge detected\. Complete it in Chrome, then press Enter/);
  assert.match(fixtures, /waits for explicit challenge continuation before acting/);
  assert.match(fixtures, /without clicking twice/);
});

test("criterion 5: prohibited authentication and evasion techniques stay absent", async () => {
  const source = (
    await Promise.all([
      read("src/browser.ts"),
      read("src/cli.ts"),
      read("src/challenge.ts"),
      read("src/preparation.ts"),
      read("src/submission.ts"),
      read("src/runtime-paths.ts"),
    ])
  ).join("\n");
  for (const prohibited of [
    /storageState|\.cookies\s*\(|addCookies|connectOverCDP|remote-debugging/i,
    /page\.route|context\.route|request\.newContext|\.on\(["']request/i,
    /ignoreDefaultArgs|navigator\.webdriver|fingerprint|stealth/i,
    /waitForTimeout|force\s*:|\.mouse\.|\.keyboard\.type/i,
    /api\.suno|\/api\/.*generate|clerk.*token|jwt/i,
  ]) {
    assert.doesNotMatch(source, prohibited);
  }
  assert.match(source, /channel: "chrome"/);
  assert.match(source, /chromium\.launchPersistentContext/);
});
