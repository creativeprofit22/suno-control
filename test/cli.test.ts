import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type BrowserContext, type Page } from "playwright";
import { runBrowserSession, runCli } from "../src/cli.js";
import type { SunoJob } from "../src/job.js";
import { resolveJobPaths, resolveRuntimePaths } from "../src/runtime-paths.js";
import { createTrackedJob, jobIdentifier, loadTrackedJob, saveTrackedJob, transitionJob } from "../src/tracking.js";

const input: SunoJob = {
  prompt: "private prompt",
  options: { style: "private style", model: "v5", instrumental: false },
};
const args = ["--prompt", input.prompt, "--style", input.options.style!, "--model", input.options.model!];
const fakePage = {} as Page;
const fakeContext = (onClose: () => void): BrowserContext =>
  ({ close: async () => onClose() }) as unknown as BrowserContext;

const captureConsole = async (run: () => Promise<number>): Promise<{ code: number; output: string[] }> => {
  const output: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  console.error = (...values: unknown[]) => output.push(values.join(" "));
  try {
    return { code: await run(), output };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
};

const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suno-cli-"));
  const runtime = resolveRuntimePaths(root);
  const paths = resolveJobPaths(runtime, jobIdentifier(input));
  return { root, runtime, paths };
};

const trackedWithReceipt = () => {
  const initial = createTrackedJob(input);
  return transitionJob({
    ...initial,
    submission: {
      attemptedAt: "2026-01-01T00:00:00.000Z",
      confirmedAt: "2026-01-01T00:00:01.000Z",
      receipt: { items: [{ testId: "track-1", title: "Song" }] },
    },
  }, "running");
};

const readDiagnostic = async (destination: string): Promise<{ stage: string; category: string }> =>
  JSON.parse(await readFile(destination, "utf8")) as { stage: string; category: string };

test("creates durable state before launching the browser and always closes", async () => {
  const { root, paths } = await fixture();
  let closed = 0;
  try {
    const result = await captureConsole(() => runCli(args, root, async () => {
      assert.ok(await loadTrackedJob(paths, jobIdentifier(input)));
      return { context: fakeContext(() => closed++), page: fakePage };
    }, { loginRequired: async () => true }));
    assert.equal(result.code, 3);
    assert.equal(closed, 1);
    assert.match(result.output.join(" "), /login-required/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed jobs return recorded outputs without launching Chrome", async () => {
  const { root, paths } = await fixture();
  let launches = 0;
  try {
    await mkdir(paths.outputs, { recursive: true });
    await writeFile(path.join(paths.outputs, "song.mp3"), "audio");
    let state = createTrackedJob(input);
    state = {
      ...state,
      submission: { attemptedAt: "2026-01-01T00:00:00.000Z", confirmedAt: "2026-01-01T00:00:01.000Z" },
      outputs: [{ visibleId: "song", completedAt: "2026-01-01T00:01:00.000Z", downloadAttempts: 1, outputPath: "outputs/song.mp3" }],
    };
    state = transitionJob(state, "completed");
    await saveTrackedJob(paths, state);
    const result = await captureConsole(() => runCli(args, root, async () => {
      launches++;
      throw new Error("must not launch");
    }));
    assert.equal(result.code, 0);
    assert.equal(launches, 0);
    assert.match(result.output.join(" "), /completed/);
    assert.equal(result.output.join(" ").includes(input.prompt), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("confirmed restart observes without a second submission", async () => {
  const { root, paths } = await fixture();
  const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ channel: "chrome", headless: true }));
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<div role="table"><div role="group" data-testid="track-1"><h2>Song</h2><div role="alert">Generation failed</div></div></div>');
  let submits = 0;
  try {
    let state = createTrackedJob(input);
    state = {
      ...state,
      submission: {
        attemptedAt: "2026-01-01T00:00:00.000Z",
        confirmedAt: "2026-01-01T00:00:01.000Z",
        receipt: { items: [{ testId: "track-1", title: "Song" }] },
      },
    };
    state = transitionJob(state, "running");
    await saveTrackedJob(paths, state);
    const result = await captureConsole(() => runCli(args, root, async () => ({ context, page }), {
      submit: async () => { submits++; return { status: "submitted" }; },
      observationLimits: { maxAttempts: 1, deadlineMs: 100, intervalMs: 0 },
    }));
    assert.equal(result.code, 8);
    assert.equal(submits, 0);
    assert.match(result.output.join(" "), /failed/);
    const diagnostic = await readDiagnostic(paths.diagnostic);
    assert.equal(diagnostic.stage, "observation");
    assert.equal(diagnostic.category, "observation-failed");
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing receipt persists an ambiguous submission diagnostic", async () => {
  const { root, paths } = await fixture();
  const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ channel: "chrome", headless: true }));
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const result = await captureConsole(() => runCli(args, root, async () => ({ context, page }), {
      loginRequired: async () => false,
      submit: async (_page, _job, _challenge, _navigation, hooks) => {
        await hooks?.beforeClick();
        return { status: "submitted" };
      },
    }));
    assert.equal(result.code, 10);
    const diagnostic = await readDiagnostic(paths.diagnostic);
    assert.equal(diagnostic.stage, "submission");
    assert.equal(diagnostic.category, "ambiguous-result");
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("unconfirmed submission persists an ambiguous diagnostic without retrying", async () => {
  const { root, paths } = await fixture();
  let launches = 0;
  try {
    await saveTrackedJob(paths, {
      ...createTrackedJob(input),
      submission: { attemptedAt: "2026-01-01T00:00:00.000Z" },
    });
    const result = await captureConsole(() => runCli(args, root, async () => {
      launches++;
      throw new Error("must not launch");
    }));
    assert.equal(result.code, 10);
    assert.equal(launches, 0);
    const diagnostic = await readDiagnostic(paths.diagnostic);
    assert.equal(diagnostic.stage, "submission");
    assert.equal(diagnostic.category, "ambiguous-result");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("observation exhaustion persists an observation failure diagnostic", async () => {
  const { root, paths } = await fixture();
  const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ channel: "chrome", headless: true }));
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<div role="table"><div role="group" data-testid="track-1"><h2>Song</h2><div role="status">Queued</div></div></div>');
  try {
    await saveTrackedJob(paths, trackedWithReceipt());
    const result = await captureConsole(() => runCli(args, root, async () => ({ context, page }), {
      observationLimits: { maxAttempts: 1, deadlineMs: 100, intervalMs: 0 },
    }));
    assert.equal(result.code, 10);
    const diagnostic = await readDiagnostic(paths.diagnostic);
    assert.equal(diagnostic.stage, "observation");
    assert.equal(diagnostic.category, "observation-failed");
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("download exhaustion persists a download failure diagnostic", async () => {
  const { root, paths } = await fixture();
  const browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ channel: "chrome", headless: true }));
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent('<div role="table"><div role="group" data-testid="track-1"><h2>Song</h2><button>Download</button></div></div>');
  try {
    await saveTrackedJob(paths, trackedWithReceipt());
    const result = await captureConsole(() => runCli(args, root, async () => ({ context, page }), {
      observationLimits: { maxAttempts: 1, deadlineMs: 100, intervalMs: 0 },
      downloadLimits: { maxAttempts: 1, timeoutMs: 1 },
    }));
    assert.equal(result.code, 10);
    const diagnostic = await readDiagnostic(paths.diagnostic);
    assert.equal(diagnostic.stage, "download");
    assert.equal(diagnostic.category, "download-failed");
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("pre-click intent persists and ambiguous acceptance cannot resubmit", async () => {
  const { root, paths } = await fixture();
  let closed = 0;
  try {
    const initial = createTrackedJob(input);
    await saveTrackedJob(paths, initial);
    const result = await captureConsole(() => runBrowserSession(
      fakeContext(() => closed++),
      fakePage,
      initial,
      paths,
      "submit",
      {
        loginRequired: async () => false,
        submit: async (_page, _job, _challenge, _navigation, hooks) => {
          await hooks?.beforeClick();
          return { status: "changed-ui" };
        },
      },
    ));
    assert.equal(result.code, 7);
    const saved = await loadTrackedJob(paths, initial.id);
    assert.ok(saved?.submission.attemptedAt);
    assert.equal(saved?.submission.confirmedAt, undefined);
    assert.equal(closed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unexpected submission errors return browser failure and close context", async () => {
  const { root, paths } = await fixture();
  let closed = 0;
  try {
    const initial = createTrackedJob(input);
    await saveTrackedJob(paths, initial);
    const result = await captureConsole(() => runBrowserSession(
      fakeContext(() => closed++),
      fakePage,
      initial,
      paths,
      "submit",
      { loginRequired: async () => false, submit: async () => { throw new Error("interrupted"); } },
    ));
    assert.equal(result.code, 4);
    assert.equal(closed, 1);
    assert.match(result.output.join(" "), /stopped unexpectedly/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [outcome, expectedExit] of [["validation-error", 5], ["rate-limited", 6]] as const) {
  test(`maps ${outcome} to a stable failed exit`, async () => {
    const { root, paths } = await fixture();
    let closed = 0;
    try {
      const initial = createTrackedJob(input);
      await saveTrackedJob(paths, initial);
      const result = await captureConsole(() => runBrowserSession(
        fakeContext(() => closed++),
        fakePage,
        initial,
        paths,
        "submit",
        {
          loginRequired: async () => false,
          submit: async (_page, _job, _challenge, _navigation, hooks) => {
            await hooks?.beforeClick();
            return { status: outcome };
          },
        },
      ));
      assert.equal(result.code, expectedExit);
      assert.equal((await loadTrackedJob(paths, initial.id))?.status, "failed");
      assert.equal(closed, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
