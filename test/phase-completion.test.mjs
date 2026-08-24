import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { launchSunoBrowser } from "../dist/src/browser.js";
import { resolveRuntimePaths } from "../dist/src/runtime-paths.js";

const root = path.resolve(import.meta.dirname, "..");
const promptSentinel = "phase-verification-prompt-do-not-print";

async function runCli() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "suno-control-phase-"));
  try {
    const child = spawn(process.execPath, [
      path.join(root, "dist/src/cli.js"),
      "--prompt", promptSentinel,
      "--style", "ambient",
      "--model", "test-model",
      "--instrumental",
    ], { cwd: tempRoot, signal: AbortSignal.timeout(60_000) });
    let output = "";
    child.stdout.on("data", chunk => output += chunk);
    child.stderr.on("data", chunk => output += chunk);
    child.stdin.end("\n");
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, output };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test("documented command starts the CLI and validates a complete Suno job", async () => {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.match(readme, /npm start -- --prompt .*--style .*--model .*--instrumental/);
  const result = await runCli();
  assert.equal(result.code, 3);
  assert.match(result.output, /Job validated\./);
  assert.doesNotMatch(result.output, new RegExp(promptSentinel));
});

test("visible persistent Chromium uses only the dedicated automation profile", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "suno-control-phase-"));
  const paths = resolveRuntimePaths(tempRoot);
  let context;
  try {
    assert.equal(paths.profile, path.join(tempRoot, ".suno-control", "browser-profile"));
    context = await launchSunoBrowser(paths);
    assert.ok(context.pages().length > 0);
    const browserSource = await readFile(path.join(root, "src/browser.ts"), "utf8");
    assert.match(browserSource, /launchPersistentContext\(paths\.profile/);
    assert.match(browserSource, /headless: false/);
  } finally {
    try {
      await context?.close();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
});

test("runtime profile downloads logs and local state are excluded", async () => {
  const ignore = await readFile(path.join(root, ".gitignore"), "utf8");
  for (const entry of [".suno-control/", "browser-profile/", "downloads/", "logs/", "local-state/", "*.log"]) {
    assert.ok(ignore.split(/\r?\n/).includes(entry), `missing ignore entry: ${entry}`);
  }
});

test("CLI has no cookie JWT or storage-state surface outside its profile", async () => {
  const files = ["src/browser.ts", "src/cli.ts", "src/job.ts", "src/runtime-paths.ts"];
  const source = (await Promise.all(files.map(file => readFile(path.join(root, file), "utf8")))).join("\n");
  assert.doesNotMatch(source, /storageState|cookies?\b|JWT|remote-debugging|executablePath|\bchannel\b|suno\.com\/api|api\.suno/i);
  assert.match(await readFile(path.join(root, ".gitignore"), "utf8"), /\*\*\/storage-state\*\.json/);
});

test("manual authentication reports login-required without bypass behavior", async () => {
  const result = await runCli();
  assert.equal(result.code, 3);
  assert.match(result.output, /Login required\. Authenticate manually in the visible Suno browser\./);
  assert.match(result.output, /Login is still required\. Complete sign-in, then run the command again\./);
  const source = await readFile(path.join(root, "src/browser.ts"), "utf8");
  assert.doesNotMatch(source, /stealth|challenge|captcha|request interception/i);
});
