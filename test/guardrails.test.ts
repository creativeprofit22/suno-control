import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const readSource = (path: string): Promise<string> =>
  readFile(new URL(`../../src/${path}`, import.meta.url), "utf8");

test("criterion 2: deterministic Playwright actions exclude sleeps and simulated-human input", async () => {
  const source = (
    await Promise.all([readSource("suno/preparation.ts"), readSource("suno/submission.ts")])
  ).join("\n");
  assert.match(source, /waitFor\(\{ state: "visible", timeout: RESULT_TIMEOUT_MS \}\)/);
  assert.match(source, /Promise\.any/);
  assert.doesNotMatch(source, /waitForTimeout|force\s*:|\.mouse\.|\.keyboard\.type/i);
});

test("criterion 5: authentication interception, browser-signal changes, and private endpoints are absent", async () => {
  const sourceDirectory = new URL("../../src/", import.meta.url);
  const files = (await readdir(sourceDirectory)).filter((file) => file.endsWith(".ts"));
  const source = [
    ...await Promise.all(files.map((file) => readFile(new URL(file, sourceDirectory), "utf8"))),
    await readSource("suno/browser.ts"),
  ].join("\n");

  for (const prohibited of [
    /storageState|\.cookies\s*\(|addCookies|connectOverCDP|remote-debugging/i,
    /page\.route|context\.route|request\.newContext|\.on\(["']request/i,
    /ignoreDefaultArgs|navigator\.webdriver|fingerprint|stealth|\bproxy\s*:/i,
    /waitForTimeout|force\s*:|\.mouse\.|\.keyboard\.type/i,
    /api\.suno|\/api\/.*generate|clerk.*token|jwt|\.tracing\.|trace\.zip/i,
  ]) {
    assert.doesNotMatch(source, prohibited);
  }

  assert.match(source, /channel: "chrome"/);
  assert.match(source, /chromium\.launchPersistentContext/);
});
