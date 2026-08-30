import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { RESULT_TIMEOUT_MS } from "../src/config.js";
import type { SunoJob } from "../src/domain/job.js";
import { runLiveSmoke } from "../src/suno/inspection.js";
import { submitSunoJob } from "../src/suno/submission.js";

const LYRICS_PROMPT =
  "What do you want your lyrics to be about? Suno will write new lyrics every generation. Leave this blank for a random topic.";
const job = (options: Partial<SunoJob["options"]> = {}): SunoJob => ({
  prompt: "A midnight train",
  options: { instrumental: false, ...options },
});

type Mode =
  | "success"
  | "validation"
  | "rate"
  | "challenge"
  | "initial-challenge"
  | "delayed-login"
  | "delayed-challenge"
  | "ready-then-delayed-login"
  | "ready-then-late-login"
  | "ready-then-delayed-challenge"
  | "ambiguous";
type Navigation = Readonly<{ createUrl: string; expectedOrigin: string }>;

const pages = new Map<string, { mode: Mode; extra: string }>();
const navigations: string[] = [];
let nextPageId = 0;
let browser: Browser | undefined;
let server: Server;
let wrongOriginServer: Server;
let baseUrl: string;
let wrongOriginUrl: string;

const html = (mode: Mode, extra = ""): string => `<!doctype html>
  <body data-mode="${
    mode === "initial-challenge" ||
    mode === "delayed-challenge" ||
    mode === "ready-then-delayed-challenge" ||
    mode === "ready-then-late-login"
      ? "success"
      : mode
  }">
    <main></main>
    <script>
      window.renderForm = () => {
        document.querySelector('main').innerHTML = \`
          <button role="tab">Advanced</button>
          <button aria-label="More Options">More Options</button>
          <label><input type="radio" role="radio" name="lyrics" aria-label="Prompt"></label>
          <label><input type="radio" role="radio" name="lyrics" aria-label="Instrumental"></label>
          <textarea aria-label="${LYRICS_PROMPT}"></textarea>
          <textarea maxlength="1000"></textarea>
          <button aria-label="v5.5" onclick="document.querySelector('[role=menu]').hidden=false">v5.5</button>
          <div role="menu" hidden><div role="menuitemradio"><span>v5</span><span>Authentic vocals</span></div></div>
          <button aria-label="Create song" onclick="
            window.submits=(window.submits||0)+1;
            const mode=document.body.dataset.mode;
            if(mode==='success') document.querySelector('[data-testid=submission-success]').hidden=false;
            if(mode==='validation') document.querySelector('[data-testid=validation-error]').hidden=false;
            if(mode==='rate') document.querySelector('[data-testid=rate-limited]').hidden=false;
            if(mode==='challenge') document.querySelector('[data-testid=interactive-challenge]').hidden=false;
          ">Create</button>
          <div data-testid="submission-success" hidden>Submitted</div>
          <div data-testid="validation-error" hidden>Validation error</div>
          <div data-testid="rate-limited" hidden>Rate limited</div>
        \`;
      };
      if ('${mode}' === 'delayed-login') {
        setTimeout(() => document.querySelector('main').innerHTML = '<button aria-label="Sign in">Sign in</button>', 100);
      } else if ('${mode}' === 'delayed-challenge') {
        setTimeout(() => document.querySelector('[data-testid=interactive-challenge]').hidden = false, 100);
      } else {
        window.renderForm();
        if ('${mode}' === 'ready-then-delayed-login') {
          setTimeout(() => document.querySelector('main').innerHTML = '<button aria-label="Sign in">Sign in</button>', 100);
        } else if ('${mode}' === 'ready-then-late-login') {
          setTimeout(() => document.querySelector('main').innerHTML = '<button aria-label="Sign in">Sign in</button>', ${RESULT_TIMEOUT_MS + 100});
        } else if ('${mode}' === 'ready-then-delayed-challenge') {
          setTimeout(() => document.querySelector('[data-testid=interactive-challenge]').hidden = false, 100);
        }
      }
    </script>
    <div data-testid="interactive-challenge" ${mode === "initial-challenge" ? "" : "hidden"}>Challenge</div>
    ${extra}
  </body>`;

const listen = (httpServer: Server): Promise<string> =>
  new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      const address = httpServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

const close = (httpServer: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()));
  });

before(async () => {
  wrongOriginServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html("success"));
  });
  wrongOriginUrl = await listen(wrongOriginServer);

  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", baseUrl);
    if (url.pathname === "/redirect") {
      navigations.push(url.href);
      response.writeHead(302, { Location: `${wrongOriginUrl}/create` });
      response.end();
      return;
    }
    const fixturePage = pages.get(url.searchParams.get("id") ?? "");
    if (url.pathname !== "/create" || fixturePage === undefined) {
      response.writeHead(404).end();
      return;
    }
    navigations.push(url.href);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html(fixturePage.mode, fixturePage.extra));
  });
  baseUrl = await listen(server);
  browser = await chromium.launch({ headless: true }).catch(() => chromium.launch({ channel: "chrome", headless: true }));
});

after(async () => {
  await browser?.close();
  await Promise.all([close(server), close(wrongOriginServer)]);
});

const fixture = async (
  mode: Mode = "success",
  extra = "",
): Promise<{ page: Page; navigation: Navigation; requestedUrls: string[] }> => {
  const id = String(nextPageId++);
  pages.set(id, { mode, extra });
  if (!browser) throw new Error("Test browser did not start.");
  const page = await browser.newPage();
  const createUrl = `${baseUrl}/create?id=${id}`;
  return {
    page,
    navigation: { createUrl, expectedOrigin: new URL(baseUrl).origin },
    requestedUrls: navigations,
  };
};

const submitCount = (page: Page): Promise<number> =>
  page.evaluate(() => Number((window as typeof window & { submits?: number }).submits ?? 0));

const smokeArtifacts = async (): Promise<{
  root: string;
  screenshot: string;
  outcome: string;
}> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suno-control-smoke-"));
  return {
    root,
    screenshot: path.join(root, "live-smoke.png"),
    outcome: path.join(root, "outcome.json"),
  };
};

test("fills semantic fields, selects the exact model, and submits once", async () => {
  const { page, navigation, requestedUrls } = await fixture();
  const navigationStart = requestedUrls.length;
  const outcome = await submitSunoJob(
    page,
    job({ style: "ambient", model: "v5" }),
    async () => undefined,
    navigation,
  );

  assert.deepEqual(outcome, { status: "submitted" });
  assert.deepEqual(requestedUrls.slice(navigationStart), [navigation.createUrl]);
  assert.equal(await page.getByRole("textbox", { name: LYRICS_PROMPT }).inputValue(), "A midnight train");
  assert.equal(await page.locator('textarea[maxlength="1000"]').inputValue(), "ambient");
  assert.equal(await page.getByRole("radio", { name: "Prompt" }).isChecked(), true);
  assert.equal(await submitCount(page), 1);
  await page.close();
});

test("live smoke waits for hydrated controls and saves artifacts without filling or submitting", async () => {
  const { page, navigation } = await fixture("success", "<script>document.querySelector('main').innerHTML=''; setTimeout(() => window.renderForm(), 100)</script>");
  const artifacts = await smokeArtifacts();

  try {
    const outcome = await runLiveSmoke(
      page,
      async () => undefined,
      artifacts,
      navigation,
    );

    assert.equal(outcome.status, "ready");
    assert.equal(outcome.challengePaused, false);
    assert.equal(outcome.submitted, false);
    assert.equal(outcome.creditsConsumed, false);
    assert.equal(outcome.screenshot, artifacts.screenshot);
    assert.equal(outcome.diagnostic.selectors.createButton.visible, true);
    assert.equal(await submitCount(page), 0);
    assert.equal(await page.getByRole("textbox", { name: LYRICS_PROMPT }).inputValue(), "");
    assert.equal(await page.locator('textarea[maxlength="1000"]').inputValue(), "");
    assert.deepEqual([...await readFile(artifacts.screenshot)].slice(0, 4), [137, 80, 78, 71]);
    assert.deepEqual(JSON.parse(await readFile(artifacts.outcome, "utf8")), outcome.diagnostic);
  } finally {
    await page.close();
    await rm(artifacts.root, { recursive: true, force: true });
  }
});

test("live smoke challenge continuation never enters the submission path", async () => {
  const { page, navigation } = await fixture("initial-challenge");
  const artifacts = await smokeArtifacts();
  let challengeCalls = 0;

  try {
    const outcome = await runLiveSmoke(
      page,
      async () => {
        challengeCalls++;
        await page.getByTestId("interactive-challenge").evaluate((element) => {
          element.setAttribute("hidden", "");
          (window as typeof window & { renderForm(): void }).renderForm();
        });
      },
      artifacts,
      navigation,
    );

    assert.equal(outcome.status, "ready");
    assert.equal(outcome.submitted, false);
    assert.equal(outcome.creditsConsumed, false);
    assert.equal(outcome.challengePaused, true);
    assert.equal(challengeCalls, 1);
    assert.equal(await page.getByRole("textbox", { name: LYRICS_PROMPT }).inputValue(), "");
    assert.equal(await page.locator('textarea[maxlength="1000"]').inputValue(), "");
    assert.equal(await submitCount(page), 0);
  } finally {
    await page.close();
    await rm(artifacts.root, { recursive: true, force: true });
  }
});

test("live smoke stays blocked when the challenge remains after continuation", async () => {
  const { page, navigation } = await fixture("initial-challenge");
  const artifacts = await smokeArtifacts();
  let challengeCalls = 0;

  try {
    const outcome = await runLiveSmoke(page, async () => { challengeCalls++; }, artifacts, navigation);

    assert.equal(outcome.status, "challenge-required");
    assert.equal(outcome.challengePaused, true);
    assert.equal(challengeCalls, 1);
    assert.equal(outcome.submitted, false);
    assert.equal(outcome.creditsConsumed, false);
    assert.equal(await page.getByRole("textbox", { name: LYRICS_PROMPT }).inputValue(), "");
    assert.equal(await page.locator('textarea[maxlength="1000"]').inputValue(), "");
    assert.equal(await submitCount(page), 0);
  } finally {
    await page.close();
    await rm(artifacts.root, { recursive: true, force: true });
  }
});

test("leaves omitted optional fields untouched", async () => {
  const { page, navigation } = await fixture();
  const outcome = await submitSunoJob(page, job(), async () => undefined, navigation);

  assert.equal(outcome.status, "submitted");
  assert.equal(await page.locator('textarea[maxlength="1000"]').inputValue(), "");
  assert.equal(await page.getByRole("menu").isHidden(), true);
  await page.close();
});

test("maps instrumental prompt and style into the style field", async () => {
  const { page, navigation } = await fixture();
  const outcome = await submitSunoJob(
    page,
    job({ instrumental: true, style: "cinematic" }),
    async () => undefined,
    navigation,
  );

  assert.equal(outcome.status, "submitted");
  assert.equal(await page.getByRole("radio", { name: "Instrumental" }).isChecked(), true);
  assert.equal(await page.locator('textarea[maxlength="1000"]').inputValue(), "A midnight train, cinematic");
  await page.close();
});

for (const [mode, status] of [
  ["validation", "validation-error"],
  ["rate", "rate-limited"],
] as const) {
  test(`classifies ${status}`, async () => {
    const { page, navigation } = await fixture(mode);
    assert.deepEqual(await submitSunoJob(page, job(), async () => undefined, navigation), { status });
    assert.equal(await submitCount(page), 1);
    await page.close();
  });
}

test("classifies a logged-out page before filling", async () => {
  const { page, navigation } = await fixture(
    "success",
    '<script>document.querySelector("main").innerHTML=""</script><button aria-label="Sign in">Sign in</button>',
  );
  assert.deepEqual(await submitSunoJob(page, job(), async () => undefined, navigation), {
    status: "login-required",
  });
  assert.equal(await submitCount(page), 0);
  await page.close();
});

test("waits for delayed login and returns before filling", async () => {
  const { page, navigation } = await fixture("delayed-login");
  assert.deepEqual(await submitSunoJob(page, job(), async () => undefined, navigation), {
    status: "login-required",
  });
  assert.equal(await submitCount(page), 0);
  await page.close();
});

test("delayed login takes precedence after Create readiness renders", async () => {
  const { page, navigation } = await fixture("ready-then-delayed-login");
  assert.deepEqual(await submitSunoJob(page, job(), async () => undefined, navigation), {
    status: "login-required",
  });
  assert.equal(await submitCount(page), 0);
  await page.close();
});

test("bounded entry polling waits for stable late login evidence before filling", async () => {
  const { page, navigation } = await fixture("ready-then-late-login");
  const outcome = await submitSunoJob(page, job(), async () => undefined, navigation);

  assert.deepEqual(outcome, { status: "login-required" });
  assert.equal(await page.getByRole("textbox", { name: LYRICS_PROMPT }).count(), 0);
  assert.equal(await submitCount(page), 0);
  await page.close();
});

test("waits for explicit challenge continuation before acting", async () => {
  const { page, navigation } = await fixture("initial-challenge");
  let continueChallenge!: () => void;
  let challengeSeen!: () => void;
  const continued = new Promise<void>((resolve) => {
    continueChallenge = resolve;
  });
  const waitingForChallenge = new Promise<void>((resolve) => {
    challengeSeen = resolve;
  });
  const submission = submitSunoJob(page, job(), async () => {
    challengeSeen();
    await continued;
  }, navigation);
  await waitingForChallenge;
  assert.equal(await submitCount(page), 0);

  await page.getByTestId("interactive-challenge").evaluate((element) => {
    element.setAttribute("hidden", "");
    (window as typeof window & { renderForm(): void }).renderForm();
  });
  continueChallenge();
  assert.equal((await submission).status, "submitted");
  assert.equal(await submitCount(page), 1);
  await page.close();
});

test("waits for a delayed challenge and explicit continuation", async () => {
  const { page, navigation } = await fixture("delayed-challenge");
  let continued = false;
  const outcome = await submitSunoJob(page, job(), async () => {
    assert.equal(await submitCount(page), 0);
    continued = true;
    await page.getByTestId("interactive-challenge").evaluate((element) => {
      element.setAttribute("hidden", "");
      (window as typeof window & { renderForm(): void }).renderForm();
    });
  }, navigation);

  assert.equal(continued, true);
  assert.equal(outcome.status, "submitted");
  assert.equal(await submitCount(page), 1);
  await page.close();
});

test("delayed challenge takes precedence after Create readiness renders", async () => {
  const { page, navigation } = await fixture("ready-then-delayed-challenge");
  let continued = false;
  const outcome = await submitSunoJob(page, job(), async () => {
    continued = true;
    await page.getByTestId("interactive-challenge").evaluate((element) => {
      element.setAttribute("hidden", "");
    });
  }, navigation);

  assert.equal(continued, true);
  assert.equal(outcome.status, "submitted");
  assert.equal(await submitCount(page), 1);
  await page.close();
});

test("returns login-required when challenge completion redirects to login", async () => {
  const { page, navigation } = await fixture("initial-challenge");
  const outcome = await submitSunoJob(page, job(), async () => {
    await page.getByTestId("interactive-challenge").evaluate((element) => {
      element.setAttribute("hidden", "");
      document.body.innerHTML = '<button aria-label="Sign in">Sign in</button>';
    });
  }, navigation);

  assert.deepEqual(outcome, { status: "login-required" });
  assert.equal(await submitCount(page), 0);
  await page.close();
});

test("rechecks delayed login after challenge continuation", async () => {
  const { page, navigation } = await fixture("initial-challenge");
  const outcome = await submitSunoJob(page, job(), async () => {
    await page.getByTestId("interactive-challenge").evaluate((element) => {
      element.setAttribute("hidden", "");
      (window as typeof window & { renderForm(): void }).renderForm();
      setTimeout(() => {
        document.querySelector("main")!.innerHTML = '<button aria-label="Sign in">Sign in</button>';
      }, 100);
    });
  }, navigation);

  assert.deepEqual(outcome, { status: "login-required" });
  assert.equal(await submitCount(page), 0);
  await page.close();
});

test("resumes after a post-submit challenge without clicking twice", async () => {
  const { page, navigation } = await fixture("challenge");
  const outcome = await submitSunoJob(page, job(), async () => {
    await page.getByTestId("interactive-challenge").evaluate((element) => {
      element.setAttribute("hidden", "");
    });
    await page.getByTestId("submission-success").evaluate((element) => {
      element.removeAttribute("hidden");
    });
  }, navigation);

  assert.equal(outcome.status, "submitted");
  assert.equal(await submitCount(page), 1);
  await page.close();
});

test("refuses a redirect to the wrong origin", async () => {
  const { page, navigation, requestedUrls } = await fixture();
  const redirectUrl = `${baseUrl}/redirect`;
  const navigationStart = requestedUrls.length;
  const outcome = await submitSunoJob(page, job(), async () => undefined, {
    ...navigation,
    createUrl: redirectUrl,
  });

  assert.deepEqual(outcome, { status: "changed-ui" });
  assert.deepEqual(requestedUrls.slice(navigationStart), [redirectUrl]);
  assert.equal(new URL(page.url()).origin, new URL(wrongOriginUrl).origin);
  assert.equal(await submitCount(page), 0);
  await page.close();
});

test("does not retry after an ambiguous post-click timeout", async () => {
  const { page, navigation } = await fixture("ambiguous");
  assert.deepEqual(await submitSunoJob(page, job(), async () => undefined, navigation), {
    status: "changed-ui",
  });
  assert.equal(await submitCount(page), 1);
  await page.close();
});

test("persists intent before one click and returns a minimal visible receipt", async () => {
  const { page, navigation } = await fixture("success", `<div role="table"></div><script>
    document.querySelector('[aria-label="Create song"]').onclick = () => {
      window.submits=(window.submits||0)+1;
      document.querySelector('[role="table"]').innerHTML = '<div role="group" data-testid="track-123"><h2>Visible Song</h2></div>';
      document.querySelector('[data-testid="submission-success"]').hidden=false;
    };
  </script>`);
  let persistedBeforeClick = false;
  const outcome = await submitSunoJob(page, job(), async () => undefined, navigation, {
    beforeClick: async () => {
      persistedBeforeClick = true;
      assert.equal(await submitCount(page), 0);
    },
  });

  assert.equal(persistedBeforeClick, true);
  assert.deepEqual(outcome, {
    status: "submitted",
    receipt: { items: [{ testId: "track-123", title: "Visible Song" }] },
  });
  assert.equal(await submitCount(page), 1);
  await page.close();
});
