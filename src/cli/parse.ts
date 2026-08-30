import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { jobIdentifier, normalizeJob, type SunoJob } from "../domain/job.js";
import type { RunJobsRequest } from "../application/run-jobs.js";

export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_QUEUE_JOBS = 100;
const scalarOptions = new Set(["prompt", "style", "model", "jobs", "concurrency", "retries"]);

export async function parseQueueRequest(args: readonly string[]): Promise<RunJobsRequest> {
  const { values } = options(args);
  const concurrency = boundedInteger(values.concurrency, "concurrency", 1, 2, 1) as 1 | 2;
  const retries = boundedInteger(values.retries, "retries", 0, 1, 0) as 0 | 1;
  let jobs: SunoJob[];
  if (values.jobs !== undefined) {
    if (values.prompt !== undefined || values.style !== undefined || values.model !== undefined || values.instrumental) {
      throw new Error("--jobs cannot be combined with generation options.");
    }
    jobs = await readManifest(requiredText(values.jobs, "jobs"));
  } else {
    jobs = [commandJob(values)];
  }
  const identifiers = jobs.map(jobIdentifier);
  if (new Set(identifiers).size !== identifiers.length) throw new Error("Manifest contains duplicate jobs.");
  return { jobs, concurrency, retries };
}

export function parseSunoJob(args: readonly string[]): SunoJob {
  const parsed = options(args);
  if (parsed.values.jobs !== undefined || parsed.values.concurrency !== undefined || parsed.values.retries !== undefined) {
    throw new Error("Queue options are not valid for a single job parser.");
  }
  return commandJob(parsed.values);
}

function options(args: readonly string[]) {
  const parsed = parseArgs({
    args: [...args], allowPositionals: false, strict: true, tokens: true,
    options: {
      prompt: { type: "string" }, style: { type: "string" }, model: { type: "string" },
      instrumental: { type: "boolean", default: false }, jobs: { type: "string" },
      concurrency: { type: "string" }, retries: { type: "string" },
    },
  });
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option" || !scalarOptions.has(token.name)) continue;
    if (seen.has(token.name)) throw new Error(`Option --${token.name} may only be provided once.`);
    seen.add(token.name);
  }
  return parsed;
}

function commandJob(values: ReturnType<typeof options>["values"]): SunoJob {
  return normalizeJob({
    prompt: requiredText(values.prompt, "prompt"),
    options: {
      instrumental: values.instrumental ?? false,
      ...(values.style === undefined ? {} : { style: values.style }),
      ...(values.model === undefined ? {} : { model: values.model }),
    },
  });
}

async function readManifest(filename: string): Promise<SunoJob[]> {
  const handle = await open(filename, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Manifest must be a regular file.");
    if (info.size > MAX_MANIFEST_BYTES) throw new Error("Manifest is too large.");
    const buffer = Buffer.alloc(Number(info.size) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_MANIFEST_BYTES) throw new Error("Manifest is too large.");
    let value: unknown;
    try { value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); }
    catch { throw new Error("Manifest is not valid JSON."); }
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_QUEUE_JOBS) throw new Error("Manifest must contain 1 to 100 jobs.");
    return value.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Manifest job is invalid.");
      const record = entry as Record<string, unknown>;
      if (Object.keys(record).some((key) => !["prompt", "options"].includes(key))) throw new Error("Manifest job is invalid.");
      if (typeof record.prompt !== "string") throw new Error("Manifest job prompt is invalid.");
      return normalizeJob({ prompt: record.prompt, options: record.options as SunoJob["options"] });
    });
  } finally { await handle.close(); }
}

function boundedInteger(value: string | undefined, name: string, minimum: number, maximum: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`Option --${name} must be an integer.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`Option --${name} must be between ${minimum} and ${maximum}.`);
  return result;
}

function requiredText(value: string | undefined, name: string): string {
  if (value === undefined) throw new Error(`Option --${name} is required.`);
  const text = value.trim();
  if (!text) throw new Error(`Option --${name} must not be blank.`);
  return text;
}
