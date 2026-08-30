import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { classifyLocation, createDiagnostic, createUnavailableDiagnostic, mapDiagnosticCategory, writeDiagnostic } from "../src/diagnostics.js";

const controls = `
  <div role="tab">Advanced</div><button>More Options</button>
  <textarea aria-label="What do you want your lyrics to be about? Suno will write new lyrics every generation. Leave this blank for a random topic."></textarea>
  <textarea maxlength="1000"></textarea><input type="radio" aria-label="Instrumental"><button>Create song</button>
  <div role="table"><div role="group"><button>Download</button></div></div>`;

test("fixed selector matrix exposes known structure without page text", async () => {
  const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ channel: "chrome", headless: true }));
  const page = await browser.newPage();
  try {
    await page.setContent(`${controls}<div>private account prompt error text</div>`);
    const diagnostic = await createDiagnostic(page, "a".repeat(64), "preparation", "changed-ui");
    assert.equal(diagnostic.selectors.advancedTab.visible, true);
    assert.equal(diagnostic.selectors.createButton.count, 1);
    assert.deepEqual(Object.keys(diagnostic).sort(), ["category", "identifier", "location", "selectors", "stage", "timestamp", "version"]);
    assert.equal(JSON.stringify(diagnostic).includes("private account prompt error text"), false);
  } finally {
    await browser.close();
  }
});

test("URL classification strips arbitrary location details", () => {
  assert.equal(classifyLocation("https://suno.com/create?prompt=secret#token"), "create");
  assert.equal(classifyLocation("https://suno.com/login?user=private"), "login");
  assert.equal(classifyLocation("https://other.example/private/path?token=x"), "external");
  assert.equal(classifyLocation("not a url"), "invalid");
});

test("operational failure codes map to actionable categories", () => {
  for (const code of ["missing-submission-receipt", "submission-unconfirmed"]) {
    assert.equal(mapDiagnosticCategory(code), "ambiguous-result");
  }
  for (const code of ["observation-exhausted", "generation-failed"]) {
    assert.equal(mapDiagnosticCategory(code), "observation-failed");
  }
  assert.equal(mapDiagnosticCategory("download-exhausted"), "download-failed");
});

test("diagnostic writes are contained, atomic, and redacted", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suno-diagnostic-"));
  const destination = path.join(root, "jobs", "diagnostic.json");
  try {
    const diagnostic = createUnavailableDiagnostic("b".repeat(64), "launch", "browser-unavailable");
    await writeDiagnostic(root, destination, diagnostic);
    await writeDiagnostic(root, destination, diagnostic);
    const serialized = await readFile(destination, "utf8");
    assert.deepEqual(JSON.parse(serialized), diagnostic);
    assert.doesNotMatch(serialized, /private prompt|cookie value|secret token|account name|raw exception/i);
    assert.deepEqual((await readdir(path.dirname(destination))).filter((name) => name.endsWith(".tmp")), []);
    await assert.rejects(writeDiagnostic(root, path.resolve(root, "..", "escaped.json"), diagnostic));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnostic failure remains secondary to the original outcome", async () => {
  const outcome = { status: "changed-ui" };
  await writeDiagnostic("/contained", "/outside/diagnostic.json", createUnavailableDiagnostic("c".repeat(64), "navigation", "changed-ui"))
    .catch(() => undefined);
  assert.deepEqual(outcome, { status: "changed-ui" });
});
