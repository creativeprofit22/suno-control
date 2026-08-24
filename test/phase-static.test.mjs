import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseSunoJob } from "../dist/src/job.js";
import { resolveRuntimePaths } from "../dist/src/runtime-paths.js";

const root = path.resolve(import.meta.dirname, "..");
const read = file => readFile(path.join(root, file), "utf8");

test("criterion 1: documented command validates prompt and generation options", async () => {
  const [readme, manifest] = await Promise.all([read("README.md"), read("package.json")]);
  assert.match(readme, /npm start -- --prompt .*--style .*--model .*--instrumental/);
  assert.match(JSON.parse(manifest).scripts.start, /dist\/src\/cli\.js/);
  assert.deepEqual(parseSunoJob(["--prompt", "test", "--style", "ambient", "--model", "model", "--instrumental"]), {
    prompt: "test",
    options: { style: "ambient", model: "model", instrumental: true },
  });
});

test("criterion 2: persistent Chromium is bound to the dedicated profile", async () => {
  const paths = resolveRuntimePaths(root);
  const source = await read("src/browser.ts");
  assert.equal(paths.profile, path.join(root, ".suno-control", "browser-profile"));
  assert.match(source, /chromium\.launchPersistentContext\(paths\.profile/);
  assert.match(source, /headless: false/);
  assert.doesNotMatch(source, /executablePath|\bchannel\b|process\.env/);
});

test("criterion 3: runtime artifacts are excluded from version control", async () => {
  const entries = (await read(".gitignore")).split(/\r?\n/);
  for (const entry of [".suno-control/", "browser-profile/", "downloads/", "logs/", "local-state/", "*.log"]) {
    assert.ok(entries.includes(entry), `missing ignore entry: ${entry}`);
  }
});

test("criterion 4: no secret export or storage-state surface exists", async () => {
  const source = (await Promise.all([
    read("src/browser.ts"), read("src/cli.ts"), read("src/job.ts"), read("src/runtime-paths.ts"),
  ])).join("\n");
  assert.doesNotMatch(source, /storageState|cookies?\b|JWT|remote-debugging|executablePath|\bchannel\b|suno\.com\/api|api\.suno/i);
  assert.match(await read(".gitignore"), /\*\*\/storage-state\*\.json/);
});

test("criterion 5: login remains manual and bypass-free", async () => {
  const [browser, cli] = await Promise.all([read("src/browser.ts"), read("src/cli.ts")]);
  assert.match(cli, /Authenticate manually in the visible Suno browser/);
  assert.match(cli, /Press Enter after login to re-check/);
  assert.match(cli, /Login is still required/);
  assert.doesNotMatch(`${browser}\n${cli}`, /stealth|captcha|challenge|request interception|bypass/i);
});
