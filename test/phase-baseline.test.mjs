import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("criterion 1 baseline records dated official version evidence", async () => {
  const document = await read("docs/baseline-2026-08.md");
  const manifest = JSON.parse(await read("node_modules/playwright-core/browsers.json"));
  const chromium = manifest.browsers.find(({ name }) => name === "chromium");
  for (const value of ["2026-08-30", "1.62.1", "22.x", "24.x", "26.x", "1234", "151.0.7922.34", "playwright.dev", "github.com/microsoft/playwright"]) {
    assert.match(document, new RegExp(value.replaceAll(".", "\\.")));
  }
  assert.equal(chromium.revision, "1234");
  assert.equal(chromium.browserVersion, "151.0.7922.34");
});

test("criterion 2 fresh live inspection is bounded and non-destructive", async (context) => {
  const document = await read("docs/baseline-2026-08.md");
  let outcome;
  try {
    outcome = JSON.parse(await read(".suno-control/smoke/outcome.json"));
  } catch (error) {
    if (error?.code !== "ENOENT" || process.env.SUNO_REQUIRE_LIVE_BASELINE === "1") throw error;
    context.skip("optional live artifact is absent");
    return;
  }
  assert.equal(outcome.stage, "smoke");
  assert.equal(outcome.location, "create");
  assert.equal(outcome.category, "structure-ready");
  for (const key of ["advancedTab", "moreOptions", "lyricsPrompt", "stylePrompt", "createButton"]) assert.equal(outcome.selectors[key].visible, true);
  for (const key of ["instrumentalMode", "loginMarker", "challengeMarker", "downloadControl"]) assert.deepEqual(outcome.selectors[key], { count: 0, visible: false });
  for (const value of ["Creation", "Authentication", "Naturally occurring challenge", "Generation status", "Download controls", "submitted=false", "creditsConsumed=false"]) {
    assert.match(document, new RegExp(value));
  }
});

test("criterion 3 architecture modules are separated", async () => {
  for (const file of [
    "src/domain/job.ts", "src/cli/presentation.ts", "src/suno/playwright-adapter.ts", "src/suno/selectors.ts",
    "src/persistence/local-job-repository.ts", "src/downloads/local-output-store.ts", "src/config.ts",
  ]) assert.equal((await stat(new URL(`../${file}`, import.meta.url))).isFile(), true, file);
});

test("criterion 6 architecture document records contracts and extension direction", async () => {
  const document = (await read("docs/architecture.md")).toLowerCase();
  for (const value of ["public contracts", "dependency direction", "future official api adapter", "src/domain/job.ts", "src/application/contracts.ts", "src/suno/playwright-adapter.ts"]) {
    assert.match(document, new RegExp(value.replaceAll(".", "\\.")));
  }
});
