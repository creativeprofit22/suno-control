import { pathToFileURL } from "node:url";
import { launchSunoBrowser } from "./suno/browser.js";
import { waitForChallengeContinue } from "./challenge.js";
import { resolveRuntimePaths } from "./config.js";
import { runLiveSmoke } from "./suno/inspection.js";

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
