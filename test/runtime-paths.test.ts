import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertPathContained, resolveRuntimePaths } from "../src/config.js";

test("uses dedicated descendants of the application runtime root", () => {
  const projectRoot = path.join(os.tmpdir(), "suno-control-project");
  const paths = resolveRuntimePaths(projectRoot);

  assert.equal(paths.root, path.resolve(projectRoot, ".suno-control"));
  for (const candidate of [
    paths.profile,
    paths.downloads,
    paths.smokeScreenshot,
    paths.smokeOutcome,
  ]) {
    const relative = path.relative(paths.root, candidate);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  }
  assert.equal(paths.profile, path.join(paths.root, "chrome-profile"));
  assert.equal(paths.downloads, path.join(paths.root, "downloads"));
  assert.equal(paths.smokeScreenshot, path.join(paths.root, "smoke", "live-smoke.png"));
  assert.equal(paths.smokeOutcome, path.join(paths.root, "smoke", "outcome.json"));
});

test("rejects paths escaping the runtime root", () => {
  const root = path.resolve(os.tmpdir(), "suno-control-runtime");
  assert.throws(() => assertPathContained(root, path.resolve(root, "..", "outside")));
});

test("rejects cross-drive Windows paths", { skip: process.platform !== "win32" }, () => {
  const rootDrive = path.parse(process.cwd()).root.slice(0, 2).toUpperCase();
  const otherDrive = rootDrive === "Z:" ? "Y:" : "Z:";
  assert.throws(() => assertPathContained(`${rootDrive}\\runtime`, `${otherDrive}\\outside`));
});
