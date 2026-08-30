import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationOutcome, JobRepository, SunoAutomation, SunoSession } from "../src/application/contracts.js";
import { runJobs } from "../src/application/run-jobs.js";
import type { SunoJob, TrackedJob } from "../src/domain/job.js";

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
  constructor(private readonly repository: MemoryRepository, private readonly submission: AutomationOutcome) {}
  async submit(_job: SunoJob, checkpoint: () => Promise<void>): Promise<AutomationOutcome> {
    await checkpoint();
    assert.ok(this.repository.job?.submission.attemptedAt, "attempt must persist before the click boundary");
    this.clicks += 1;
    return this.submission;
  }
  async observe(): Promise<AutomationOutcome> { return { status: "completed", outputs: [{ visibleId: "track-1", downloadAttempts: 1, outputPath: "outputs/track.mp3" }] }; }
  async close(): Promise<void> {}
}

test("persists attemptedAt before one submission and completes through contracts", async () => {
  const repository = new MemoryRepository();
  const session = new FakeSession(repository, { status: "accepted", receipt: { items: [{ visibleId: "track-1" }] } });
  const automation: SunoAutomation = { open: async () => session };
  const result = await runJobs({ jobs: [input], concurrency: 1, retries: 0 }, { repository, automation }, () => undefined);
  assert.equal(result.exitCode, 0);
  assert.equal(session.clicks, 1);
  assert.equal(repository.job?.status, "completed");
});

test("never resubmits an ambiguous saved attempt", async () => {
  const repository = new MemoryRepository();
  const first = new FakeSession(repository, { status: "unknown" });
  await runJobs({ jobs: [input], concurrency: 1, retries: 0 }, { repository, automation: { open: async () => first } }, () => undefined);
  assert.equal(first.clicks, 1);
  const second = new FakeSession(repository, { status: "accepted", receipt: { items: [{ visibleId: "track-1" }] } });
  const result = await runJobs({ jobs: [input], concurrency: 1, retries: 0 }, { repository, automation: { open: async () => second } }, () => undefined);
  assert.equal(result.exitCode, 10);
  assert.equal(second.clicks, 0);
});
