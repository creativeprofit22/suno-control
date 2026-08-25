import { pathToFileURL } from "node:url";
import type { BrowserContext, Page } from "playwright";
import { launchSunoBrowser, isLoginRequired } from "./browser.js";
import { waitForChallengeContinue } from "./challenge.js";
import { parseSunoJob, type SunoJob } from "./job.js";
import { resolveRuntimePaths } from "./runtime-paths.js";
import { submitSunoJob, type SubmissionOutcome } from "./submission.js";

const EXIT_INVALID_JOB = 2;
const EXIT_LOGIN_REQUIRED = 3;
const EXIT_BROWSER = 4;
const EXIT_VALIDATION = 5;
const EXIT_RATE_LIMITED = 6;
const EXIT_CHANGED_UI = 7;

async function main(): Promise<number> {
  let job: SunoJob;
  try {
    job = parseSunoJob(process.argv.slice(2));
  } catch {
    console.error("Invalid job. Provide one non-empty --prompt and valid generation options.");
    return EXIT_INVALID_JOB;
  }

  console.log("Job validated.");
  const paths = resolveRuntimePaths(process.cwd());
  let browser;

  try {
    browser = await launchSunoBrowser(paths);
  } catch (error) {
    console.error(browserLaunchMessage(error));
    return EXIT_BROWSER;
  }

  return runBrowserSession(browser.context, browser.page, job);
}

type SubmitJob = (
  page: Page,
  job: SunoJob,
  waitForChallengeContinue: () => Promise<void>,
) => Promise<SubmissionOutcome>;

export async function runBrowserSession(
  context: BrowserContext,
  page: Page,
  job: SunoJob,
  submit: SubmitJob = submitSunoJob,
  loginRequired: (page: Page) => Promise<boolean> = isLoginRequired,
  waitForChallenge: () => Promise<void> = waitForChallengeContinue,
): Promise<number> {
  try {
    if (await loginRequired(page)) {
      console.error(
        "Login required. Authenticate once in normal Chrome with the dedicated Suno profile, then retry.",
      );
      return EXIT_LOGIN_REQUIRED;
    }

    const outcome = await submit(page, job, waitForChallenge);
    return reportOutcome(outcome);
  } catch {
    console.error("Browser session ended. Run the command again to continue.");
    return EXIT_BROWSER;
  } finally {
    await context.close().catch(() => undefined);
  }
}

function reportOutcome(outcome: SubmissionOutcome): number {
  if (outcome.status === "submitted") {
    console.log("Job submitted.");
    return 0;
  }
  if (outcome.status === "login-required") {
    console.error("Login required. Authenticate in the dedicated Chrome profile, then retry.");
    return EXIT_LOGIN_REQUIRED;
  }
  if (outcome.status === "validation-error") {
    console.error("Suno rejected the job fields. Review the options and retry.");
    return EXIT_VALIDATION;
  }
  if (outcome.status === "rate-limited") {
    console.error("Suno is rate limiting creation. Wait before submitting another job.");
    return EXIT_RATE_LIMITED;
  }
  console.error("Suno's Create page changed or did not confirm submission. Check the visible browser.");
  return EXIT_CHANGED_UI;
}

function browserLaunchMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : "";
  if (/ProcessSingleton|profile.*in use|user data directory.*in use/i.test(detail)) {
    return "Automation profile is in use. Close the dedicated Chrome window, then retry.";
  }
  if (/executable.*doesn.t exist|browser.*not found/i.test(detail)) {
    return "Google Chrome is not installed in a location Playwright can use.";
  }
  return "Browser could not start. Close the dedicated Chrome window and verify Chrome is installed.";
}


if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
