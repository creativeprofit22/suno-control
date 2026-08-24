import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import type { BrowserContext } from "playwright";
import { launchSunoBrowser, isLoginRequired } from "./browser.js";
import { parseSunoJob } from "./job.js";
import { resolveRuntimePaths } from "./runtime-paths.js";

const EXIT_INVALID_JOB = 2;
const EXIT_LOGIN_REQUIRED = 3;
const EXIT_BROWSER = 4;

async function main(): Promise<number> {
  try {
    parseSunoJob(process.argv.slice(2));
  } catch {
    console.error("Invalid job. Provide one non-empty --prompt and valid generation options.");
    return EXIT_INVALID_JOB;
  }

  console.log("Job validated.");
  const paths = resolveRuntimePaths(process.cwd());
  let context;

  try {
    context = await launchSunoBrowser(paths);
  } catch (error) {
    console.error(browserLaunchMessage(error));
    return EXIT_BROWSER;
  }

  return runBrowserSession(context);
}

export async function runBrowserSession(
  context: BrowserContext,
  loginRequired: (context: BrowserContext) => Promise<boolean> = isLoginRequired,
): Promise<number> {
  try {
    if (await loginRequired(context)) {
      console.log("Login required. Authenticate manually in the visible Suno browser.");
      await waitForEnter("Press Enter after login to re-check: ");
      if (await loginRequired(context)) {
        console.error("Login is still required. Complete sign-in, then run the command again.");
        return EXIT_LOGIN_REQUIRED;
      }
    }

    console.log("Browser is ready. Authentication status is not inferred from page controls.");
    await waitForEnter("Press Enter to close the browser: ");
    return 0;
  } catch {
    console.error("Browser session ended. Run the command again to continue.");
    return EXIT_BROWSER;
  } finally {
    await context.close().catch(() => undefined);
  }
}

function browserLaunchMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : "";
  if (/ProcessSingleton|profile.*in use|user data directory.*in use/i.test(detail)) {
    return "Automation profile is in use. Close the other CLI browser, then retry.";
  }
  if (/executable.*doesn.t exist|browser.*not found/i.test(detail)) {
    return "Bundled Chromium is not installed. Run: npm run install-browser";
  }
  return "Browser could not start. Close other CLI browsers and verify Chromium is installed.";
}

async function waitForEnter(prompt: string): Promise<void> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  try {
    await input.question(prompt, { signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    input.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
