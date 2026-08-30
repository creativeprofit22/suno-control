import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { parseSunoJob } from "./cli/parse.js";
import { resolveRuntimePaths, type RuntimePaths } from "./config.js";
import type { SunoJob } from "./domain/job.js";
import {
  prepareAssistedSunoJob,
  type AssistanceOutcome,
  type ManualGate,
} from "./suno/assistance.js";
import { launchSunoBrowser, type SunoBrowser } from "./suno/browser.js";

type AssistedBrowserContext = SunoBrowser["context"];

export const EXIT_INVALID_ASSIST_INPUT = 2;
export const EXIT_LOGIN_REQUIRED = 3;
export const EXIT_BROWSER_LAUNCH_FAILED = 4;
export const EXIT_CHALLENGE_REQUIRED = 5;
export const EXIT_CHANGED_UI = 7;

export interface AssistOutput {
  log(line: string): void;
  error(line: string): void;
}

export interface BrowserLifecycle {
  isClosed(): boolean;
  once(event: "close", listener: () => void): unknown;
  close(): Promise<void>;
}

export interface AssistDependencies {
  paths: RuntimePaths;
  launch(paths: RuntimePaths): Promise<SunoBrowser>;
  prepare(
    page: SunoBrowser["page"],
    job: SunoJob,
    waitForManualContinue: (gate: ManualGate) => Promise<void>,
  ): Promise<AssistanceOutcome>;
  waitForManualContinue(gate: ManualGate): Promise<void>;
}

const consoleOutput: AssistOutput = { log: console.log, error: console.error };

export async function waitForManualAssistContinue(gate: ManualGate): Promise<void> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const instruction = gate === "login"
      ? "Sign in manually in Chrome, then press Enter here: "
      : "Complete the interactive challenge in Chrome, then press Enter here: ";
    await input.question(instruction, { signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    input.close();
  }
}

export async function waitUntilBrowserCloses(context: BrowserLifecycle): Promise<void> {
  if (context.isClosed()) return;
  await new Promise<void>((resolve) => context.once("close", resolve));
}

const installSignalCleanup = (context: AssistedBrowserContext): (() => void) => {
  const close = (): void => { void context.close().catch(() => undefined); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return () => {
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
  };
};

async function launchAndPrepare(
  job: SunoJob,
  dependencies: AssistDependencies,
): Promise<{ context: AssistedBrowserContext; outcome: AssistanceOutcome; removeSignalCleanup: () => void }> {
  const { context, page } = await dependencies.launch(dependencies.paths);
  const removeSignalCleanup = installSignalCleanup(context);
  try {
    const outcome = await dependencies.prepare(page, job, dependencies.waitForManualContinue);
    return { context, outcome, removeSignalCleanup };
  } catch (error) {
    removeSignalCleanup();
    await context.close().catch(() => undefined);
    throw error;
  }
}

export async function runAssistCli(
  args: readonly string[],
  dependencies: AssistDependencies,
  output: AssistOutput = consoleOutput,
): Promise<number> {
  let job: SunoJob;
  try {
    job = parseSunoJob(args);
  } catch {
    output.error("Invalid assisted job. Provide one prompt and generation options only.");
    return EXIT_INVALID_ASSIST_INPUT;
  }

  let prepared;
  try {
    prepared = await launchAndPrepare(job, dependencies);
  } catch {
    output.error("Browser could not start or prepare. Close dedicated Chrome and retry.");
    return EXIT_BROWSER_LAUNCH_FAILED;
  }

  const { context, outcome, removeSignalCleanup } = prepared;
  try {
    if (outcome.status === "login-required") {
      output.error("Login is still required. Complete sign-in and run assisted mode again.");
      return EXIT_LOGIN_REQUIRED;
    }
    if (outcome.status === "challenge-required") {
      output.error("The interactive challenge remains. Complete it and run assisted mode again.");
      return EXIT_CHALLENGE_REQUIRED;
    }
    if (outcome.status === "changed-ui") {
      output.error("Suno Create controls changed. Nothing was submitted.");
      return EXIT_CHANGED_UI;
    }

    output.log("Preparation complete. Automation has stopped; review every field and click Create manually.");
    output.log("Close the dedicated browser window to exit assisted mode.");
    await waitUntilBrowserCloses(context);
    return 0;
  } finally {
    removeSignalCleanup();
    if (outcome.status !== "ready-for-review") await context.close().catch(() => undefined);
  }
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runAssistCli(args, {
    paths: resolveRuntimePaths(process.cwd()),
    launch: launchSunoBrowser,
    prepare: prepareAssistedSunoJob,
    waitForManualContinue: waitForManualAssistContinue,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
