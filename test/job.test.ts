import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_MANIFEST_BYTES, parseQueueRequest, parseSunoJob } from "../src/job.js";

test("parses a complete Suno job", () => {
  assert.deepEqual(
    parseSunoJob([
      "--prompt", "  quiet rain  ",
      "--style", " ambient ",
      "--model", " current-model ",
      "--instrumental",
    ]),
    {
      prompt: "quiet rain",
      options: { style: "ambient", model: "current-model", instrumental: true },
    },
  );
});

test("parses required input with defaults", () => {
  assert.deepEqual(parseSunoJob(["--prompt", "song"]), {
    prompt: "song",
    options: { instrumental: false },
  });
});

for (const [name, args] of [
  ["missing prompt", []],
  ["blank prompt", ["--prompt", "   "]],
  ["blank style", ["--prompt", "song", "--style", " "]],
  ["blank model", ["--prompt", "song", "--model", " "]],
  ["unknown option", ["--prompt", "song", "--other", "value"]],
  ["duplicate scalar option", ["--prompt", "one", "--prompt", "two"]],
  ["positional input", ["--prompt", "song", "extra"]],
] as const) {
  test(`rejects ${name}`, () => {
    assert.throws(() => parseSunoJob(args));
  });
}

const withManifest = async (value: unknown, run: (filename: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suno-manifest-"));
  const filename = path.join(root, "jobs.json");
  try {
    await writeFile(filename, JSON.stringify(value));
    await run(filename);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("keeps single-job queue compatibility and conservative defaults", async () => {
  assert.deepEqual(await parseQueueRequest(["--prompt", "song"]), {
    jobs: [{ prompt: "song", options: { instrumental: false } }], concurrency: 1, retries: 0,
  });
});

test("parses an exact bounded manifest with explicit limits", async () => {
  await withManifest([{ prompt: "one", options: { instrumental: true, style: "jazz" } }], async (filename) => {
    const parsed = await parseQueueRequest(["--jobs", filename, "--concurrency", "2", "--retries", "1"]);
    assert.equal(parsed.jobs.length, 1);
    assert.equal(parsed.concurrency, 2);
    assert.equal(parsed.retries, 1);
  });
});

test("rejects manifest extra fields, duplicates, and count ceilings", async () => {
  await withManifest([{ prompt: "one", options: { instrumental: false }, secret: "no" }], async (filename) => {
    await assert.rejects(parseQueueRequest(["--jobs", filename]));
  });
  await withManifest(Array.from({ length: 2 }, () => ({ prompt: "same", options: { instrumental: false } })), async (filename) => {
    await assert.rejects(parseQueueRequest(["--jobs", filename]));
  });
  await withManifest(Array.from({ length: 101 }, (_, index) => ({ prompt: String(index), options: { instrumental: false } })), async (filename) => {
    await assert.rejects(parseQueueRequest(["--jobs", filename]));
  });
});

test("rejects oversized manifests and invalid or repeated queue limits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suno-manifest-"));
  const filename = path.join(root, "large.json");
  try {
    await writeFile(filename, Buffer.alloc(MAX_MANIFEST_BYTES + 1, 32));
    await assert.rejects(parseQueueRequest(["--jobs", filename]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  for (const args of [
    ["--prompt", "song", "--concurrency", "0"],
    ["--prompt", "song", "--concurrency", "3"],
    ["--prompt", "song", "--retries", "2"],
    ["--prompt", "song", "--retries", "0", "--retries", "1"],
  ]) await assert.rejects(parseQueueRequest(args));
});