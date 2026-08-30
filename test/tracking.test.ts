import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SunoJob } from "../src/domain/job.js";
import { resolveJobPaths, resolveRuntimePaths } from "../src/config.js";
import { LocalOutputStore } from "../src/downloads/local-output-store.js";
import { createTrackedJob, jobIdentifier, resumeAction, transitionJob } from "../src/domain/job.js";
import { LocalJobRepository } from "../src/persistence/local-job-repository.js";

const input: SunoJob = {
  prompt: "A midnight train",
  options: { style: "ambient", model: "v5", instrumental: false },
};

const fixture = async () => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "suno-tracking-")));
  const runtime = resolveRuntimePaths(root);
  const paths = resolveJobPaths(runtime, jobIdentifier(input));
  return { root, runtime, paths, repository: new LocalJobRepository(runtime), outputs: new LocalOutputStore(runtime) };
};

test("identifier is deterministic over normalized prompt and options", () => {
  const reordered: SunoJob = {
    prompt: input.prompt,
    options: { instrumental: false, model: "v5", style: "ambient" },
  };
  assert.equal(jobIdentifier(input), jobIdentifier(reordered));
  assert.notEqual(jobIdentifier(input), jobIdentifier({ ...input, prompt: "Another train" }));
});

test("atomically round-trips strict state and timestamped transitions", async () => {
  const { root, paths, repository } = await fixture();
  try {
    const queued = createTrackedJob(input, new Date("2026-01-01T00:00:00.000Z"));
    const running = transitionJob(queued, "running", new Date("2026-01-01T00:01:00.000Z"));
    await repository.save(running);
    assert.deepEqual(await repository.load(running.id), running);
    assert.deepEqual(running.history.map(({ status, at }) => [status, at]), [
      ["queued", "2026-01-01T00:00:00.000Z"],
      ["running", "2026-01-01T00:01:00.000Z"],
    ]);
  } finally {
    await chmod(paths.state, 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed, inconsistent, and secret-bearing state fails closed", async () => {
  const { root, paths, repository } = await fixture();
  try {
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.state, "not json");
    await assert.rejects(repository.load(jobIdentifier(input)), /malformed/);

    const state = createTrackedJob(input);
    await writeFile(paths.state, JSON.stringify({ ...state, cookie: "secret" }));
    await assert.rejects(repository.load(state.id), /unsupported fields/);

    await writeFile(paths.state, JSON.stringify({ ...state, id: "0".repeat(64) }));
    await assert.rejects(repository.load(state.id), /does not match/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart decisions never resubmit attempted work and repair missing outputs", async () => {
  const { root, paths, repository } = await fixture();
  try {
    const queued = createTrackedJob(input);
    assert.equal(resumeAction(queued, false), "submit");
    const attempted = { ...queued, submission: { attemptedAt: "2026-01-01T00:00:00.000Z" } };
    assert.equal(resumeAction(attempted, false), "review");
    const confirmed = { ...attempted, submission: { ...attempted.submission, confirmedAt: "2026-01-01T00:00:01.000Z" } };
    assert.equal(resumeAction(confirmed, false), "observe");

    const completed = transitionJob({
      ...confirmed,
      outputs: [{ visibleId: "track-1", completedAt: "2026-01-01T00:02:00.000Z", downloadAttempts: 1, outputPath: "outputs/song.mp3" }],
    }, "completed");
    await mkdir(paths.outputs, { recursive: true });
    await writeFile(path.join(paths.outputs, "song.mp3"), "audio");
    assert.equal(await repository.outputsExist(completed), true);
    assert.equal(resumeAction(completed, true), "complete");
    await rm(path.join(paths.outputs, "song.mp3"));
    assert.equal(await repository.outputsExist(completed), false);
    assert.equal(resumeAction(completed, false), "observe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exclusive output persistence preserves colliding media", async () => {
  const { root, runtime, paths, outputs } = await fixture();
  try {
    await mkdir(paths.outputs, { recursive: true });
    await mkdir(runtime.downloads, { recursive: true });
    await writeFile(path.join(paths.outputs, "song.mp3"), "old");
    const temporary = path.join(runtime.downloads, ".new.tmp");
    await writeFile(temporary, "new");
    assert.equal(await outputs.persist(jobIdentifier(input), { path: temporary, suggestedName: "song.mp3" }), path.join("outputs", "song-1.mp3"));
    assert.equal(await readFile(path.join(paths.outputs, "song.mp3"), "utf8"), "old");
    assert.equal(await readFile(path.join(paths.outputs, "song-1.mp3"), "utf8"), "new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository and output contracts reject paths outside a job", async () => {
  const { root, repository, outputs } = await fixture();
  try {
    const state = { ...createTrackedJob(input), outputs: [{ visibleId: "track-1", downloadAttempts: 0, outputPath: "../outside.mp3" }] };
    await assert.rejects(repository.save(state), /path|directory/);
    await assert.rejects(outputs.exists(state.id, "../outside.mp3"), /path|directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serialized metadata excludes unsupported secret fields", async () => {
  const { root, paths, repository } = await fixture();
  try {
    await repository.save(createTrackedJob(input));
    const text = await readFile(paths.state, "utf8");
    for (const forbidden of ["cookie", "authorization", "storageState", "headers"]) {
      assert.equal(text.toLowerCase().includes(forbidden.toLowerCase()), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
