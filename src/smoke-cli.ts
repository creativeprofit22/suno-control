import { pathToFileURL } from "node:url";
import { launchSunoBrowser } from "./browser.js";
import { waitForChallengeContinue } from "./challenge.js";
import type { SunoJob } from "./job.js";
import { resolveRuntimePaths } from "./runtime-paths.js";
import { runLiveSmoke } from "./smoke.js";

const SMOKE_JOB: SunoJob = {
  prompt: "Smoke test only — do not generate",
  options: { instrumental: false, style: "ambient", model: "v5" },
};

async function main(): Promise<number> {
  const paths = resolveRuntimePaths(process.cwd());
  let browser;

  try {
    browser = await launchSunoBrowser(paths);
  } catch {
    console.error("Browser could not start. Close the dedicated Chrome window and retry.");
    return 4;
  }

  try {
    const outcome = await runLiveSmoke(
      browser.page,
      SMOKE_JOB,
      waitForChallengeContinue,
      { root: paths.root, screenshot: paths.smokeScreenshot, outcome: paths.smokeOutcome },
    );
    console.log(`Smoke ${outcome.status}; submitted=false.`);
    if (outcome.status === "ready") return 0;
    if (outcome.status === "login-required") return 3;
    return 7;
  } catch {
    console.error("Live smoke check failed before its artifacts were saved.");
    return 4;
  } finally {
    await browser.context.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
