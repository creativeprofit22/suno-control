import type { RunJobsDependencies } from "../application/run-jobs.js";
import { runJobs } from "../application/run-jobs.js";
import { parseQueueRequest } from "./parse.js";

export const EXIT_INVALID_JOB = 2;
export const EXIT_UNKNOWN = 10;

export interface CliOutput {
  log(line: string): void;
  error(line: string): void;
}

const consoleOutput: CliOutput = { log: console.log, error: console.error };

export async function runCli(
  args: readonly string[],
  dependencies: RunJobsDependencies,
  output: CliOutput = consoleOutput,
): Promise<number> {
  let request;
  try {
    request = await parseQueueRequest(args);
  } catch {
    output.error("Invalid job or manifest. Check queue inputs and generation options.");
    return EXIT_INVALID_JOB;
  }
  try {
    return (await runJobs(request, dependencies, output.log)).exitCode;
  } catch {
    output.error("Queue state is invalid. Review contained job state before retrying.");
    return EXIT_UNKNOWN;
  }
}
