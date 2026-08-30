import assert from "node:assert/strict";
import test from "node:test";
import type { JobRepository, SunoAutomation } from "../src/application/contracts.js";
import { runCli } from "../src/cli/presentation.js";
import { resolveRuntimePaths } from "../src/config.js";
import type { TrackedJob } from "../src/domain/job.js";

const unusedRepository: JobRepository = {
  load: async () => undefined,
  save: async (_job: TrackedJob) => undefined,
  outputsExist: async () => false,
};

const unusedAutomation: SunoAutomation = { open: async () => { throw new Error("must not launch"); } };
const paths = resolveRuntimePaths(process.cwd());

const capture = () => {
  const lines: string[] = [];
  return { lines, output: { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) } };
};

test("invalid CLI input returns a stable redacted exit without launching", async () => {
  const { lines, output } = capture();
  const code = await runCli(["--prompt", "private prompt", "--concurrency", "3"], { repository: unusedRepository, automation: unusedAutomation, paths }, output);
  assert.equal(code, 2);
  assert.deepEqual(lines, ["Invalid job or manifest. Check queue inputs and generation options."]);
  assert.equal(lines.join(" ").includes("private prompt"), false);
});

test("unexpected repository errors return a stable redacted exit", async () => {
  const { lines, output } = capture();
  const repository: JobRepository = { ...unusedRepository, load: async () => { throw new Error("secret state"); } };
  const code = await runCli(["--prompt", "private prompt"], { repository, automation: unusedAutomation, paths }, output);
  assert.equal(code, 10);
  assert.equal(lines.join(" ").includes("private prompt"), false);
  assert.equal(lines.join(" ").includes("secret state"), false);
});
