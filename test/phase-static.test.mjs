import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("forbidden browser techniques remain absent", async () => {
  const sources = await Promise.all([
    "src/suno/browser.ts", "src/suno/preparation.ts", "src/suno/submission.ts",
    "src/suno/completion.ts", "src/suno/inspection.ts", "src/challenge.ts", "src/config.ts",
    "src/application/run-jobs.ts", "src/domain/job.ts", "src/persistence/local-job-repository.ts",
  ].map(read)).then((parts) => parts.join("\n"));
  for (const prohibited of [
    /storageState|\.cookies\s*\(|addCookies|connectOverCDP|remote-debugging/i,
    /page\.route|context\.route|request\.newContext|\.on\(["']request/i,
    /ignoreDefaultArgs|navigator\.webdriver|fingerprint|stealth/i,
    /waitForTimeout|force\s*:|\.mouse\.|\.keyboard\.type/i,
    /api\.suno|\/api\/.*generate|clerk.*token|jwt/i,
  ]) assert.doesNotMatch(sources, prohibited);
  assert.match(sources, /channel: "chrome"/);
  assert.match(sources, /chromium\.launchPersistentContext/);
});
