import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AutomationOutcome, JobCheckpoint, JobRepository, SunoAutomation, SunoSession } from "../src/application/contracts.js";
import { runJobs } from "../src/application/run-jobs.js";
import { resolveJobPaths, resolveRuntimePaths } from "../src/config.js";
import { jobIdentifier, type SunoJob, type TrackedJob } from "../src/domain/job.js";
import type { RedactedDiagnostic } from "../src/suno/diagnostics.js";

const input: SunoJob = { prompt: "private prompt", options: { instrumental: false } };

class MemoryRepository implements JobRepository {
  job?: TrackedJob;
  saves: TrackedJob[] = [];
  async load(): Promise<TrackedJob | undefined> { return this.job; }
  async save(job: TrackedJob): Promise<void> { this.job = structuredClone(job); this.saves.push(this.job); }
  async outputsExist(): Promise<boolean> { return false; }
}

class FakeSession implements SunoSession {
  clicks = 0;
  constructor(
    private readonly repository: MemoryRepository,
    private readonly submission: AutomationOutcome,
    private readonly observation: AutomationOutcome = {
      status: "completed",
      outputs: [{ visibleId: "track-1", downloadAttempts: 1, outputPath: "outputs/track.mp3" }],
    },
  ) {}
  async submit(_job: SunoJob, checkpoint: () => Promise<void>): Promise<AutomationOutcome> {
    await checkpoint();
    assert.ok(this.repository.job?.submission.attemptedAt, "attempt must persist before the click boundary");
    this.clicks += 1;
    return this.submission;
  }
  async observe(job: TrackedJob, checkpoint: (value: JobCheckpoint) => Promise<TrackedJob>): Promise<AutomationOutcome> {
    if (this.observation.outputs) await checkpoint({ kind: "download", job: { ...job, outputs: this.observation.outputs } });
    return this.observation;
  }
  async close(): Promise<void> {}
}

test("criterion 4 persists attemptedAt before one submission and completes through contracts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suno-run-jobs-"));
  try {
    const repository = new MemoryRepository();
    const session = new FakeSession(repository, { status: "accepted", receipt: { items: [{ visibleId: "track-1" }] } });
    const automation: SunoAutomation = { open: async () => session };
    const result = await runJobs(
      { jobs: [input], concurrency: 1, retries: 0 },
      { repository, automation, paths: resolveRuntimePaths(root) },
      () => undefined,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(session.clicks, 1);
    assert.equal(repository.job?.status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("criterion 5 persists observation attempts across restarts and exhausts the global limit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suno-run-jobs-"));
  try {
    const paths = resolveRuntimePaths(root);
    const repository = new MemoryRepository();
    repository.job = {
      version: 1,
      id: jobIdentifier(input),
      ...input,
      status: "running",
      history: [{ status: "queued", at: new Date().toISOString() }, { status: "running", at: new Date().toISOString() }],
      submission: { attemptedAt: new Date().toISOString(), confirmedAt: new Date().toISOString(), receipt: { items: [{ visibleId: "track-1" }] } },
      observationAttempts: 0,
      outputs: [],
    };
    const attempts: number[] = [];
    const automation = (runLimit: number): SunoAutomation => ({ open: async () => ({
      async submit() { throw new Error("saved jobs must not be resubmitted"); },
      async observe(job, checkpoint) {
        for (let attempt = job.observationAttempts + 1; attempt <= Math.min(3, runLimit); attempt++) {
          attempts.push(attempt);
          await checkpoint({ kind: "observation", attempt, status: attempt === 1 ? "queued" : "running" });
        }
        return { status: "unknown", stage: "observation", code: "observation-exhausted" };
      },
      async close() {},
    }) });

    await runJobs({ jobs: [input], concurrency: 1, retries: 0 }, { repository, automation: automation(2), paths }, () => undefined);
    assert.equal(repository.job?.observationAttempts, 2);
    await runJobs({ jobs: [input], concurrency: 1, retries: 0 }, { repository, automation: automation(3), paths }, () => undefined);
    assert.equal(repository.job?.observationAttempts, 3);
    await runJobs({ jobs: [input], concurrency: 1, retries: 0 }, { repository, automation: automation(3), paths }, () => undefined);
    assert.deepEqual(attempts, [1, 2, 3]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("criterion 5 never resubmits an ambiguous saved attempt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suno-run-jobs-"));
  try {
    const paths = resolveRuntimePaths(root);
    const repository = new MemoryRepository();
    const first = new FakeSession(repository, { status: "unknown" });
    await runJobs({ jobs: [input], concurrency: 1, retries: 0 }, { repository, automation: { open: async () => first }, paths }, () => undefined);
    assert.equal(first.clicks, 1);
    const second = new FakeSession(repository, { status: "accepted", receipt: { items: [{ visibleId: "track-1" }] } });
    const result = await runJobs({ jobs: [input], concurrency: 1, retries: 0 }, { repository, automation: { open: async () => second }, paths }, () => undefined);
    assert.equal(result.exitCode, 10);
    assert.equal(second.clicks, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "submission",
    submission: { status: "validation-rejected", stage: "submission", code: "validation-error", location: "suno-login", facts: [{ key: "createButton", count: 1, visible: true }] } satisfies AutomationOutcome,
    expectedCategory: "validation-rejected",
    expectedStage: "submission",
    expectedSelector: "createButton",
    expectedCount: 1,
  },
  {
    name: "observation",
    submission: { status: "accepted", receipt: { items: [{ visibleId: "track-1" }] } } satisfies AutomationOutcome,
    observation: { status: "unknown", stage: "observation", code: "observation-exhausted", location: "suno-create", facts: [{ key: "resultContainer", count: 2, visible: true }] } satisfies AutomationOutcome,
    expectedCategory: "observation-failed",
    expectedStage: "observation",
    expectedSelector: "resultContainer",
    expectedCount: 2,
  },
  {
    name: "download",
    submission: { status: "accepted", receipt: { items: [{ visibleId: "track-1" }] } } satisfies AutomationOutcome,
    observation: { status: "unknown", stage: "download", code: "download-failed", location: "external", facts: [{ key: "downloadControl", count: 1, visible: true }] } satisfies AutomationOutcome,
    expectedCategory: "download-failed",
    expectedStage: "download",
    expectedSelector: "downloadControl",
    expectedCount: 1,
  },
]) {
  test(`${scenario.name} failure writes one redacted runtime diagnostic`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "suno-run-jobs-"));
    try {
      const paths = resolveRuntimePaths(root);
      const repository = new MemoryRepository();
      const session = new FakeSession(repository, scenario.submission, scenario.observation);
      const result = await runJobs({ jobs: [input], concurrency: 1, retries: 0 }, { repository, automation: { open: async () => session }, paths }, () => undefined);
      assert.notEqual(result.exitCode, 0);
      const serialized = await readFile(resolveJobPaths(paths, jobIdentifier(input)).diagnostic, "utf8");
      const diagnostic = JSON.parse(serialized);
      assert.equal(diagnostic.stage, scenario.expectedStage);
      assert.equal(diagnostic.category, scenario.expectedCategory);
      assert.equal(diagnostic.selectors[scenario.expectedSelector].count, scenario.expectedCount);
      assert.doesNotMatch(serialized, /private prompt|raw URL|exception|cookie|account|storage|header|network|screenshot/i);
      assert.deepEqual(Object.keys(diagnostic).sort(), ["category", "identifier", "location", "selectors", "stage", "timestamp", "version"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("browser launch failure writes a fixed unavailable diagnostic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suno-run-jobs-"));
  try {
    const paths = resolveRuntimePaths(root);
    const repository = new MemoryRepository();
    const result = await runJobs(
      { jobs: [input], concurrency: 1, retries: 0 },
      { repository, automation: { open: async () => { throw new Error("private browser exception"); } }, paths },
      () => undefined,
    );
    assert.equal(result.results[0]?.status, "browser-failed");
    const diagnostic: RedactedDiagnostic = JSON.parse(await readFile(resolveJobPaths(paths, jobIdentifier(input)).diagnostic, "utf8"));
    assert.equal(diagnostic.stage, "launch");
    assert.equal(diagnostic.category, "browser-unavailable");
    assert.ok(Object.values(diagnostic.selectors).every((fact) => fact.count === 0 && fact.visible === false));
    assert.equal(JSON.stringify(diagnostic).includes("private browser exception"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("diagnostic writer failure preserves the original result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suno-run-jobs-"));
  try {
    const paths = resolveRuntimePaths(root);
    await writeFile(paths.root, "not a directory");
    const repository = new MemoryRepository();
    const outcome: AutomationOutcome = { status: "validation-rejected", stage: "submission", code: "validation-error", location: "suno-create", facts: [] };
    const session = new FakeSession(repository, outcome);
    const result = await runJobs({ jobs: [input], concurrency: 1, retries: 0 }, { repository, automation: { open: async () => session }, paths }, () => undefined);
    assert.equal(result.exitCode, 5);
    assert.equal(result.results[0]?.status, "validation-rejected");
    assert.equal(repository.job?.error?.code, "validation-error");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
