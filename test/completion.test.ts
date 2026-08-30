import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import {
  classifyVisibleCompletion,
  downloadCompletedTracks,
  observeCompletion,
  reacquireReceipt,
} from "../src/completion.js";
import type { SunoJob } from "../src/job.js";
import { resolveJobPaths, resolveRuntimePaths } from "../src/runtime-paths.js";
import { createTrackedJob, jobIdentifier, type SubmissionReceipt, type TrackedJob } from "../src/tracking.js";

let browser: Browser | undefined;
const input: SunoJob = { prompt: "A midnight train", options: { instrumental: false } };
const receipt: SubmissionReceipt = { items: [{ testId: "track-1", title: "Song One" }] };

before(async () => {
  browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ channel: "chrome", headless: true }));
});
after(async () => { await browser?.close(); });

const pageWith = async (contents: string): Promise<Page> => {
  if (!browser) throw new Error("Test browser did not start.");
  const page = await browser.newPage();
  await page.setContent(`<main><div role="table">${contents}</div></main>`);
  return page;
};

const card = (state: string, extra = "", id = "track-1", title = "Song One"): string => `
  <div role="group" data-testid="${id}">
    <h2>${title}</h2>${state}${extra}
  </div>`;

test("observes queued to running to completed with bounded attempts", async () => {
  const page = await pageWith(card('<div role="status">Queued</div>'));
  const observed: string[] = [];
  let sleeps = 0;
  try {
    const result = await observeCompletion(
      page,
      receipt,
      {
        maxAttempts: 3,
        deadlineMs: 1_000,
        intervalMs: 1,
        now: () => 0,
        sleep: async () => {
          sleeps++;
          const group = page.getByTestId("track-1");
          await group.getByRole("status").evaluate((element) => element.remove());
          await group.evaluate((element, step) => {
            element.insertAdjacentHTML("beforeend", step === 1
              ? '<div role="status">Generating</div>'
              : '<button aria-label="Download">Download</button>');
          }, sleeps);
        },
      },
      async (observation) => { observed.push(observation.status); },
    );
    assert.equal(result.status, "completed");
    assert.deepEqual(observed, ["queued", "running", "completed"]);
  } finally {
    await page.close();
  }
});

test("classifies explicit failed, blocked, and contradictory states", async () => {
  const failedPage = await pageWith(card('<div role="alert">Generation failed</div>'));
  const blockedPage = await pageWith('<div data-testid="interactive-challenge">Challenge</div>');
  const ambiguousPage = await pageWith(card('<div role="status">Queued</div><button aria-label="Download">Download</button>'));
  try {
    assert.equal((await classifyVisibleCompletion(failedPage, receipt)).status, "failed");
    assert.equal((await classifyVisibleCompletion(blockedPage, receipt)).status, "blocked");
    assert.equal((await classifyVisibleCompletion(ambiguousPage, receipt)).status, "unknown");
  } finally {
    await Promise.all([failedPage.close(), blockedPage.close(), ambiguousPage.close()]);
  }
});

test("receipt reacquisition requires exactly one matching visible container", async () => {
  const page = await pageWith(`${card('<div role="status">Queued</div>')}${card('<div role="status">Queued</div>')}`);
  try {
    assert.equal(await reacquireReceipt(page, receipt), undefined);
  } finally {
    await page.close();
  }
});

test("observation exhaustion is bounded and actionable", async () => {
  const page = await pageWith(card('<div role="status">Queued</div>'));
  let calls = 0;
  try {
    const result = await observeCompletion(
      page,
      receipt,
      { maxAttempts: 2, deadlineMs: 100, intervalMs: 0, now: () => 0, sleep: async () => undefined },
      async () => { calls++; },
    );
    assert.equal(result.status, "unknown");
    assert.equal(calls, 3);
    assert.match("error" in result ? result.error.message : "", /retry limit/);
  } finally {
    await page.close();
  }
});

const downloadFixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suno-download-"));
  const paths = resolveJobPaths(resolveRuntimePaths(root), jobIdentifier(input));
  await mkdir(paths.outputs, { recursive: true });
  return { root, paths };
};

test("real Playwright downloads preserve collisions and record separate outputs", async () => {
  const { root, paths } = await downloadFixture();
  const page = await pageWith(
    `${card("", '<a aria-label="Download" href="https://fixture.test/one">Download</a>')}` +
    `${card("", '<a aria-label="Download" href="https://fixture.test/two">Download</a>', "track-2", "Song Two")}`,
  );
  await page.route("https://fixture.test/one", (route) => route.fulfill({
    body: Buffer.from("new-one"),
    headers: { "content-disposition": 'attachment; filename="Song One.mp3"', "content-type": "audio/mpeg" },
  }));
  await page.route("https://fixture.test/two", (route) => route.fulfill({
    body: Buffer.from("new-two"),
    headers: { "content-disposition": 'attachment; filename="Song Two.mp3"', "content-type": "audio/mpeg" },
  }));
  await writeFile(path.join(paths.outputs, "Song One.mp3"), "old-one");
  const twoReceipt: SubmissionReceipt = { items: [...receipt.items, { testId: "track-2", title: "Song Two" }] };
  try {
    const observation = await classifyVisibleCompletion(page, twoReceipt);
    assert.equal(observation.status, "completed");
    if (observation.status !== "completed") throw new Error("Expected completed fixture.");
    let saved: TrackedJob = createTrackedJob(input);
    saved = await downloadCompletedTracks(page, paths, saved, observation.tracks, { maxAttempts: 2, timeoutMs: 2_000 }, async (job) => { saved = job; });
    assert.equal(saved.status, "completed");
    assert.equal(saved.prompt, input.prompt);
    assert.deepEqual(saved.options, { instrumental: false });
    assert.deepEqual(saved.outputs.map(({ visibleId, title }) => ({ visibleId, title })), [
      { visibleId: "Song One", title: "Song One" },
      { visibleId: "Song Two", title: "Song Two" },
    ]);
    for (const output of saved.outputs) {
      assert.match(output.completedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
      assert.match(output.outputPath ?? "", /^outputs[\\/]/);
    }
    assert.equal(await readFile(path.join(paths.outputs, "Song One.mp3"), "utf8"), "old-one");
    assert.equal(await readFile(path.join(paths.outputs, "Song One-1.mp3"), "utf8"), "new-one");
    assert.equal(await readFile(path.join(paths.outputs, "Song Two.mp3"), "utf8"), "new-two");
  } finally {
    await page.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("download retries are bounded and never click after an output is recorded", async () => {
  const { root, paths } = await downloadFixture();
  const page = await pageWith(card("", '<button aria-label="Download" onclick="window.clicks=(window.clicks||0)+1">Download</button>'));
  try {
    const observation = await classifyVisibleCompletion(page, receipt);
    assert.equal(observation.status, "completed");
    if (observation.status !== "completed") throw new Error("Expected completed fixture.");
    let saved = createTrackedJob(input);
    saved = await downloadCompletedTracks(page, paths, saved, observation.tracks, { maxAttempts: 2, timeoutMs: 20 }, async (job) => { saved = job; });
    assert.equal(saved.status, "unknown");
    assert.equal(saved.outputs[0]?.downloadAttempts, 2);
    assert.equal(await page.evaluate(() => (window as typeof window & { clicks?: number }).clicks), 2);

    const existing = { ...saved, status: "running" as const, outputs: [{ ...saved.outputs[0]!, outputPath: "outputs/existing.mp3" }] };
    await writeFile(path.join(paths.outputs, "existing.mp3"), "kept");
    await downloadCompletedTracks(page, paths, existing, observation.tracks, { maxAttempts: 2, timeoutMs: 20 }, async () => undefined);
    assert.equal(await page.evaluate(() => (window as typeof window & { clicks?: number }).clicks), 2);
  } finally {
    await page.close();
    await rm(root, { recursive: true, force: true });
  }
});
