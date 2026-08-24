import { spawnSync } from "node:child_process";

const argument = process.argv.slice(2).find(value => /^--criterion=[1-5]$/.test(value));
if (!argument) {
  console.error("Use exactly one --criterion=1 through --criterion=5 argument.");
  process.exitCode = 2;
} else {
  const criterion = argument.at(-1);
  const result = spawnSync(process.execPath, [
    "--test",
    `--test-name-pattern=criterion ${criterion}`,
    "test/phase-static.test.mjs",
  ], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}
