import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { EXIT_BROWSER_LAUNCH_FAILED, runAssistCli, type AssistOutput } from "../src/assist-cli.js";
import { resolveRuntimePaths } from "../src/config.js";
import type { SunoJob } from "../src/domain/job.js";
import {
  ASSIST_ACTION_DELAY_MS,
  ASSIST_CHARACTER_DELAY_MS,
  fillAssistedSunoForm,
  prepareAssistedSunoJob,
  type AssistedFormControls,
} from "../src/suno/assistance.js";
import { LYRICS_PROMPT } from "../src/suno/form-controls.js";

const vocalJob: SunoJob = {
  prompt: "Hi\nx",
  options: { instrumental: false, style: "lo", model: "v5" },
};

const fakeControls = (): { controls: AssistedFormControls; actions: string[] } => {
  const actions: string[] = [];
  const visible = { count: async () => 1, isVisible: async () => true };
  const click = (name: string) => ({
    ...visible,
    click: async () => { actions.push(`click:${name}`); },
  });
  const text = (name: string) => ({
    ...visible,
    fill: async (value: string) => { actions.push(`fill:${name}:${JSON.stringify(value)}`); },
  });
  return {
    actions,
    controls: {
      advanced: click("advanced"),
      moreOptions: click("more"),
      style: text("style"),
      instrumental: click("instrumental"),
      promptMode: click("prompt"),
      lyrics: text("lyrics"),
      modelButton: click("model-button"),
      modelOption: (name: string) => click(`model:${name}`),
    },
  };
};

test("vocal assistance fills progressively at the exact fixed cadence", async () => {
  const { controls, actions } = fakeControls();
  const sleeps: number[] = [];

  assert.equal(await fillAssistedSunoForm(controls, vocalJob, async (milliseconds) => { sleeps.push(milliseconds); }), true);
  assert.deepEqual(actions, [
    "click:advanced", "click:more", "click:prompt",
    "click:model-button", "click:model:v5",
    'fill:lyrics:"H"', 'fill:lyrics:"Hi"', 'fill:lyrics:"Hi\\n"', 'fill:lyrics:"Hi\\nx"',
    'fill:style:"l"', 'fill:style:"lo"',
  ]);
  assert.deepEqual(sleeps, [
    ASSIST_ACTION_DELAY_MS, ASSIST_ACTION_DELAY_MS, ASSIST_ACTION_DELAY_MS,
    ASSIST_ACTION_DELAY_MS, ASSIST_ACTION_DELAY_MS,
    ASSIST_CHARACTER_DELAY_MS, ASSIST_CHARACTER_DELAY_MS, ASSIST_CHARACTER_DELAY_MS, ASSIST_CHARACTER_DELAY_MS,
    ASSIST_ACTION_DELAY_MS, ASSIST_CHARACTER_DELAY_MS, ASSIST_CHARACTER_DELAY_MS,
  ]);
});

test("instrumental assistance combines prompt and style in the style field", async () => {
  const { controls, actions } = fakeControls();
  const job: SunoJob = { prompt: "Orbit", options: { instrumental: true, style: "cinematic" } };

  assert.equal(await fillAssistedSunoForm(controls, job, async () => undefined), true);
  assert.ok(actions.includes("click:instrumental"));
  assert.equal(actions.at(-1), 'fill:style:"Orbit, cinematic"');
  assert.ok(!actions.some((action) => action.startsWith("fill:lyrics")));
});

type FixtureMode = "ready" | "login" | "challenge" | "changed" | "changed-model";
let browser: Browser;
let server: Server;
let baseUrl: string;

const lyricsMarkup = `<textarea placeholder="${LYRICS_PROMPT}" maxlength="3000"></textarea>`;

const formMarkup = (model = "v5"): string => `
  <form>
    <button type="button" role="tab">Advanced</button>
    <div role="button" tabindex="0">More Options</div>
    <button id="prompt-mode" type="button" role="radio" aria-checked="false">Prompt</button>
    <button id="instrumental-mode" type="button" role="radio" aria-checked="false">Instrumental</button>
    <div id="lyrics-slot"></div>
    <textarea maxlength="1000"></textarea>
    <button type="button" aria-label="v5.5" onclick="document.querySelector('[role=menu]').hidden=false">v5.5</button>
    <div role="menu" hidden><div role="menuitemradio">${model}</div></div>
    <button type="button" aria-label="Create song" onclick="window.metrics.createClicks++">Create</button>
    <div id="result">Result</div><a id="download" href="/download">Download</a>
  </form>`;

const fixtureHtml = (mode: FixtureMode): string => `<!doctype html><body><main></main><script>
  window.metrics = { createClicks: 0, submissions: 0, enterEvents: 0, resultReads: 0, downloadReads: 0 };
  window.renderForm = () => {
    document.querySelector('main').innerHTML = ${JSON.stringify(formMarkup(mode === "changed-model" ? "v4" : "v5"))};
    document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); window.metrics.submissions++; });
    document.querySelector('#prompt-mode').addEventListener('click', () => {
      document.querySelector('#prompt-mode').setAttribute('aria-checked', 'true');
      document.querySelector('#instrumental-mode').setAttribute('aria-checked', 'false');
      ${mode === "changed" ? "" : `document.querySelector('#lyrics-slot').innerHTML = ${JSON.stringify(lyricsMarkup)};`}
    });
    document.querySelector('#instrumental-mode').addEventListener('click', () => {
      document.querySelector('#instrumental-mode').setAttribute('aria-checked', 'true');
      document.querySelector('#prompt-mode').setAttribute('aria-checked', 'false');
      document.querySelector('#lyrics-slot').innerHTML = '';
    });
    const result = document.querySelector('#result');
    Object.defineProperty(result, 'innerText', { get: () => { window.metrics.resultReads++; return 'Result'; } });
    const download = document.querySelector('#download');
    Object.defineProperty(download, 'href', { get: () => { window.metrics.downloadReads++; return '/download'; } });
  };
  document.addEventListener('keydown', event => { if (event.key === 'Enter') window.metrics.enterEvents++; });
  ${mode === "login"
    ? "document.querySelector('main').innerHTML='<button aria-label=\"Sign in\">Sign in</button>';"
    : mode === "challenge"
      ? "document.querySelector('main').innerHTML='<div data-testid=\"interactive-challenge\">Challenge</div>';"
      : "window.renderForm();"}
</script></body>`;

const listen = (httpServer: Server): Promise<string> => new Promise((resolve, reject) => {
  httpServer.once("error", reject);
  httpServer.listen(0, "127.0.0.1", () => {
    httpServer.off("error", reject);
    resolve(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`);
  });
});

before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", baseUrl);
    if (url.pathname === "/download") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" }).end("unused");
      return;
    }
    const mode = url.searchParams.get("mode") as FixtureMode | null;
    if (url.pathname !== "/create" || !mode || !["ready", "login", "challenge", "changed", "changed-model"].includes(mode)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(fixtureHtml(mode));
  });
  baseUrl = await listen(server);
  browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ channel: "chrome", headless: true }));
});

after(async () => {
  await browser.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

const fixturePage = async (mode: FixtureMode): Promise<{ page: Page; navigation: { createUrl: string; expectedOrigin: string } }> => {
  const page = await browser.newPage();
  return {
    page,
    navigation: { createUrl: `${baseUrl}/create?mode=${mode}`, expectedOrigin: new URL(baseUrl).origin },
  };
};

const metrics = (page: Page): Promise<Record<string, number>> => page.evaluate(() =>
  (window as typeof window & { metrics: Record<string, number> }).metrics,
);

test("current button-radio fixture reveals placeholder-only lyrics after selecting Prompt", async () => {
  const { page, navigation } = await fixturePage("ready");
  try {
    const outcome = await prepareAssistedSunoJob(page, vocalJob, async () => undefined, navigation, async () => undefined);
    assert.deepEqual(outcome, { status: "ready-for-review" });
    assert.equal(await page.getByRole("radio", { name: "Prompt" }).evaluate((element) => element.tagName), "BUTTON");
    assert.equal(await page.getByPlaceholder(LYRICS_PROMPT).inputValue(), "Hi\nx");
    assert.deepEqual(await metrics(page), {
      createClicks: 0, submissions: 0, enterEvents: 0, resultReads: 0, downloadReads: 0,
    });
  } finally {
    await page.close();
  }
});

for (const mode of ["login", "challenge"] as const) {
  test(`${mode} requires one manual continuation without sending terminal input to the page`, async () => {
    const { page, navigation } = await fixturePage(mode);
    const gates: string[] = [];
    try {
      const outcome = await prepareAssistedSunoJob(page, vocalJob, async (gate) => {
        gates.push(gate);
        await page.evaluate(() => (window as typeof window & { renderForm(): void }).renderForm());
      }, navigation, async () => undefined);
      assert.deepEqual(outcome, { status: "ready-for-review" });
      assert.deepEqual(gates, [mode]);
      assert.equal((await metrics(page)).enterEvents, 0);
      assert.equal((await metrics(page)).createClicks, 0);
    } finally {
      await page.close();
    }
  });
}

test("changed controls fail closed before requested values are written", async () => {
  const { page, navigation } = await fixturePage("changed");
  try {
    assert.deepEqual(
      await prepareAssistedSunoJob(page, vocalJob, async () => undefined, navigation, async () => undefined),
      { status: "changed-ui" },
    );
    assert.equal(await page.locator('textarea[maxlength="1000"]').inputValue(), "");
    assert.equal(await page.getByRole("radio", { name: "Prompt" }).getAttribute("aria-checked"), "true");
    assert.equal(await page.getByPlaceholder(LYRICS_PROMPT).count(), 0);
    assert.equal((await metrics(page)).createClicks, 0);
  } finally {
    await page.close();
  }
});

test("missing model fails closed before requested values are written", async () => {
  const { page, navigation } = await fixturePage("changed-model");
  try {
    assert.deepEqual(
      await prepareAssistedSunoJob(page, vocalJob, async () => undefined, navigation, async () => undefined),
      { status: "changed-ui" },
    );
    assert.equal(await page.getByPlaceholder(LYRICS_PROMPT).inputValue(), "");
    assert.equal(await page.locator('textarea[maxlength="1000"]').inputValue(), "");
    assert.equal((await metrics(page)).createClicks, 0);
  } finally {
    await page.close();
  }
});

test("preparation navigation failures reject instead of reporting changed controls", async () => {
  const navigationError = new Error("preparation navigation failed");
  const page = {
    setDefaultTimeout: () => undefined,
    goto: async () => { throw navigationError; },
  } as unknown as Page;

  await assert.rejects(
    prepareAssistedSunoJob(page, vocalJob, async () => undefined),
    navigationError,
  );
});

test("preparation navigation failures use the browser failure CLI exit and message", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("**/*", (route) => route.abort("failed"));
  const lines: string[] = [];
  const output: AssistOutput = { log: (line) => lines.push(line), error: (line) => lines.push(line) };

  const exitCode = await runAssistCli(["--prompt", "fixture"], {
    paths: resolveRuntimePaths(process.cwd()),
    launch: async () => ({ context, page }),
    prepare: prepareAssistedSunoJob,
    waitForManualContinue: async () => undefined,
  }, output);

  assert.equal(exitCode, EXIT_BROWSER_LAUNCH_FAILED);
  assert.deepEqual(lines, ["Browser could not start or prepare. Close dedicated Chrome and retry."]);
  assert.equal(context.isClosed(), true);
});

test("ready CLI waits until the browser closes and does not close it itself", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const lines: string[] = [];
  const output: AssistOutput = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
  const running = runAssistCli(["--prompt", "fixture"], {
    paths: resolveRuntimePaths(process.cwd()),
    launch: async () => ({ context, page }),
    prepare: async () => ({ status: "ready-for-review" }),
    waitForManualContinue: async () => undefined,
  }, output);

  while (!lines.some((line) => line.includes("Preparation complete"))) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.isClosed(), false);
  await context.close();
  assert.equal(await running, 0);
});
