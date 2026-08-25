import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext, Page } from "playwright";
import { runBrowserSession } from "../src/cli.js";
import type { SunoJob } from "../src/job.js";
import type { SubmissionOutcome } from "../src/submission.js";

const job: SunoJob = {
  prompt: "private prompt",
  options: { style: "private style", model: "v5", instrumental: false },
};
const page = {} as Page;

const context = (onClose: () => void): BrowserContext =>
  ({ close: async () => onClose() }) as unknown as BrowserContext;

const captureConsole = async (run: () => Promise<number>): Promise<{
  code: number;
  output: string[];
}> => {
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

test("forwards the parsed job, wires challenge continuation, and closes", async () => {
  let closeCalls = 0;
  let challengeCalls = 0;
  let receivedPage: Page | undefined;
  let receivedJob: SunoJob | undefined;

  const result = await captureConsole(() =>
    runBrowserSession(
      context(() => closeCalls++),
      page,
      job,
      async (submittedPage, submittedJob, continueChallenge) => {
        receivedPage = submittedPage;
        receivedJob = submittedJob;
        await continueChallenge();
        return { status: "submitted" };
      },
      async () => false,
      async () => {
        challengeCalls++;
      },
    ),
  );

  assert.equal(result.code, 0);
  assert.deepEqual(result.output, ["Job submitted."]);
  assert.equal(receivedPage, page);
  assert.equal(receivedJob, job);
  assert.equal(challengeCalls, 1);
  assert.equal(closeCalls, 1);
});

test("returns login-required without submitting and still closes", async () => {
  let closeCalls = 0;
  let submitCalls = 0;
  const result = await captureConsole(() =>
    runBrowserSession(
      context(() => closeCalls++),
      page,
      job,
      async () => {
        submitCalls++;
        return { status: "submitted" };
      },
      async () => true,
    ),
  );

  assert.equal(result.code, 3);
  assert.match(result.output[0] ?? "", /Login required/);
  assert.equal(submitCalls, 0);
  assert.equal(closeCalls, 1);
});

for (const [outcome, code, message] of [
  [{ status: "login-required" }, 3, /Login required/],
  [{ status: "validation-error" }, 5, /rejected the job fields/],
  [{ status: "rate-limited" }, 6, /rate limiting/],
  [{ status: "changed-ui" }, 7, /Create page changed/],
] as const satisfies readonly [SubmissionOutcome, number, RegExp][]) {
  test(`maps ${outcome.status} to its stable exit code and message`, async () => {
    let closeCalls = 0;
    const result = await captureConsole(() =>
      runBrowserSession(
        context(() => closeCalls++),
        page,
        job,
        async () => outcome,
        async () => false,
      ),
    );

    assert.equal(result.code, code);
    assert.match(result.output[0] ?? "", message);
    assert.equal(result.output.join(" ").includes(job.prompt), false);
    assert.equal(closeCalls, 1);
  });
}

test("submission failure returns browser error and closes", async () => {
  let closeCalls = 0;
  const result = await captureConsole(() =>
    runBrowserSession(
      context(() => closeCalls++),
      page,
      job,
      async () => {
        throw new Error("interrupted");
      },
      async () => false,
    ),
  );

  assert.equal(result.code, 4);
  assert.match(result.output[0] ?? "", /Browser session ended/);
  assert.equal(closeCalls, 1);
});
