import assert from "node:assert/strict";
import test from "node:test";
import { eligibleForRetry, runQueue, type QueueJobResult, type QueueRuntime } from "../src/queue.js";

interface Input { id: string; result?: QueueJobResult }
const completed = (attempted = true): QueueJobResult => ({ status: "completed", exitCode: 0, submissionAttempted: attempted });

function runtime(events: string[], run?: QueueRuntime<Input, Input, object, object>["run"]): QueueRuntime<Input, Input, object, object> {
  return {
    prepare: async (input) => { events.push(`prepare:${input.id}`); return { id: input.id.padEnd(64, "0"), value: input, submissionAttempted: false }; },
    launch: async () => { events.push("launch"); return {}; },
    open: async () => { events.push("open"); return {}; },
    run: run ?? (async (job) => { events.push(`run:${job.value.id}`); return job.value.result ?? completed(); }),
    closeHandle: async () => { events.push("close-page"); },
    closeSession: async () => { events.push("close-context"); },
  };
}

test("sequential default prepares every state before launch and reports every job", async () => {
  const events: string[] = [];
  const lines: string[] = [];
  const result = await runQueue([{ id: "a" }, { id: "b" }], { concurrency: 1, retries: 0 }, runtime(events), lines.push.bind(lines));
  assert.deepEqual(events.slice(0, 3), ["prepare:a", "prepare:b", "launch"]);
  assert.deepEqual(events.filter((event) => event.startsWith("run:")), ["run:a", "run:b"]);
  assert.equal(events.at(-1), "close-context");
  assert.equal(lines.filter((line) => /completed\.$/.test(line)).length, 2);
  assert.match(lines.at(-1)!, /completed=2/);
  assert.equal(result.exitCode, 0);
});

test("explicit concurrency never exceeds two and closes all pages", async () => {
  const events: string[] = [];
  let active = 0;
  let maximum = 0;
  const result = await runQueue(
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    { concurrency: 2, retries: 0 },
    runtime(events, async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return completed();
    }),
    () => undefined,
  );
  assert.equal(maximum, 2);
  assert.equal(events.filter((event) => event === "close-page").length, 3);
  assert.equal(result.exitCode, 0);
});

test("enforcement stops new dispatch while preserving untouched jobs as queued", async () => {
  const events: string[] = [];
  const blocked: QueueJobResult = { status: "rate-limited", exitCode: 6, category: "rate-limit", submissionAttempted: true };
  const result = await runQueue(
    [{ id: "a", result: blocked }, { id: "b" }, { id: "c" }],
    { concurrency: 1, retries: 0 },
    runtime(events),
    () => undefined,
  );
  assert.deepEqual(result.results.map((entry) => entry.status), ["rate-limited", "queued", "queued"]);
  assert.deepEqual(events.filter((event) => event.startsWith("run:")), ["run:a"]);
  assert.equal(result.exitCode, 9);
});

test("retries one eligible pre-attempt browser failure only", async () => {
  const events: string[] = [];
  let attempts = 0;
  const result = await runQueue([{ id: "a" }], { concurrency: 1, retries: 1 }, runtime(events, async () => {
    attempts++;
    return attempts === 1
      ? { status: "browser-failed", exitCode: 4, category: "browser-failure", submissionAttempted: false }
      : completed(false);
  }), () => undefined);
  assert.equal(attempts, 2);
  assert.equal(result.exitCode, 0);
});

test("never retries attempted, ambiguous, login, challenge, validation, enforcement, or changed UI work", () => {
  for (const result of [
    { status: "browser-failed", exitCode: 4, category: "browser-failure", submissionAttempted: true },
    { status: "unknown", exitCode: 10, category: "ambiguous", submissionAttempted: false },
    { status: "login-required", exitCode: 3, category: "login", submissionAttempted: false },
    { status: "blocked", exitCode: 9, category: "challenge", submissionAttempted: false },
    { status: "validation-rejected", exitCode: 5, category: "validation", submissionAttempted: false },
    { status: "rate-limited", exitCode: 6, category: "rate-limit", submissionAttempted: false },
    { status: "account-blocked", exitCode: 9, category: "account-block", submissionAttempted: false },
    { status: "changed-ui", exitCode: 7, category: "changed-ui", submissionAttempted: false },
  ] as QueueJobResult[]) assert.equal(eligibleForRetry(result, 1, 1), false);
});

test("terminal restart work settles without launching a browser", async () => {
  let launches = 0;
  const events: string[] = [];
  const base = runtime(events);
  base.prepare = async (input) => ({
    id: input.id.padEnd(64, "0"), value: input, submissionAttempted: true, terminal: completed(),
  });
  base.launch = async () => { launches++; return {}; };
  const result = await runQueue([{ id: "a" }], { concurrency: 1, retries: 0 }, base, () => undefined);
  assert.equal(launches, 0);
  assert.equal(result.exitCode, 0);
});
