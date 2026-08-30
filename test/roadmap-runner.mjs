import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const criterionTargets = {
  1: ["dist/test/completion.test.js", "dist/test/tracking.test.js"],
  2: ["dist/test/completion.test.js"],
  3: ["dist/test/completion.test.js"],
  4: ["dist/test/completion.test.js", "dist/test/run-jobs.test.js", "dist/test/tracking.test.js"],
  5: ["dist/test/run-jobs.test.js", "dist/test/tracking.test.js"],
};
const argument = process.argv.slice(2).find((value) => /^--criterion=[1-5]$/.test(value));
const compiledTestDirectory = new URL("../dist/test/", import.meta.url);
const compiledTests = readdirSync(compiledTestDirectory)
  .filter((file) => file.endsWith(".test.js"))
  .map((file) => fileURLToPath(new URL(file, compiledTestDirectory)));
const testArguments = argument
  ? ["--test", `--test-name-pattern=criterion ${argument.at(-1)}`, ...criterionTargets[argument.at(-1)]]
  : ["--test", "test/architecture.test.mjs", ...compiledTests, "test/phase-static.test.mjs", "test/phase-baseline.test.mjs"];
const result = spawnSync(process.execPath, testArguments, { shell: false, stdio: "inherit" });
process.exitCode = result.status ?? 1;
