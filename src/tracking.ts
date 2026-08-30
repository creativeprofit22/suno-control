import { randomUUID } from "node:crypto";
import { constants, copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { jobIdentifier, normalizeJob, type SunoJob } from "./job.js";
import { assertPathContained, type JobPaths } from "./runtime-paths.js";

export const TRACKING_VERSION = 1;
export const JOB_STATUSES = ["queued", "running", "completed", "failed", "blocked", "unknown"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface ReceiptItem {
  testId?: string;
  title?: string;
  visibleId?: string;
}

export interface SubmissionReceipt {
  items: ReceiptItem[];
}

export interface TrackedOutput {
  visibleId: string;
  title?: string;
  completedAt?: string;
  downloadAttempts: number;
  outputPath?: string;
}

export interface TrackedJob {
  version: typeof TRACKING_VERSION;
  id: string;
  prompt: string;
  options: SunoJob["options"];
  status: JobStatus;
  history: Array<{ status: JobStatus; at: string }>;
  submission: { attemptedAt?: string; confirmedAt?: string; receipt?: SubmissionReceipt };
  observationAttempts: number;
  outputs: TrackedOutput[];
  error?: { code: string; message: string };
}

export type ResumeAction = "submit" | "observe" | "complete" | "review";

export { jobIdentifier } from "./job.js";

export function createTrackedJob(job: SunoJob, now = new Date()): TrackedJob {
  const normalized = normalizeJob(job);
  return {
    version: TRACKING_VERSION,
    id: jobIdentifier(normalized),
    ...normalized,
    status: "queued",
    history: [{ status: "queued", at: now.toISOString() }],
    submission: {},
    observationAttempts: 0,
    outputs: [],
  };
}

export function transitionJob(
  job: TrackedJob,
  status: JobStatus,
  now = new Date(),
  error?: { code: string; message: string },
): TrackedJob {
  const { error: _previousError, ...withoutError } = job;
  return {
    ...withoutError,
    status,
    history: [...job.history, { status, at: now.toISOString() }],
    ...(error ? { error } : {}),
  };
}

export function resumeAction(job: TrackedJob, outputsExist: boolean): ResumeAction {
  if (job.submission.attemptedAt && !job.submission.confirmedAt) return "review";
  if (!job.submission.attemptedAt) return "submit";
  if (job.status === "completed" && outputsExist) return "complete";
  return "observe";
}

export async function recordedOutputsExist(job: TrackedJob, paths: JobPaths): Promise<boolean> {
  if (job.outputs.length === 0 || job.outputs.some((output) => !output.outputPath)) return false;
  for (const output of job.outputs) {
    const candidate = containedOutputPath(paths, output.outputPath!);
    try {
      if (!(await stat(candidate)).isFile()) return false;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }
  return true;
}

export async function loadTrackedJob(paths: JobPaths, expectedId: string): Promise<TrackedJob | undefined> {
  let text: string;
  try {
    text = await readFile(paths.state, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Saved job state is malformed; review it before retrying.");
  }
  return validateTrackedJob(value, expectedId, paths);
}

export async function saveTrackedJob(paths: JobPaths, job: TrackedJob): Promise<void> {
  validateTrackedJob(job, job.id, paths);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const temporary = assertPathContained(paths.root, path.join(paths.root, `.state-${randomUUID()}.tmp`));
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(job, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, paths.state);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function persistExclusiveOutput(
  paths: JobPaths,
  temporary: string,
  preferredName: string,
): Promise<string> {
  await mkdir(paths.outputs, { recursive: true, mode: 0o700 });
  const parsed = path.parse(safeFilename(preferredName));
  for (let suffix = 0; ; suffix += 1) {
    const name = suffix === 0 ? `${parsed.name}${parsed.ext}` : `${parsed.name}-${suffix}${parsed.ext}`;
    const candidate = assertPathContained(paths.outputs, path.join(paths.outputs, name));
    try {
      await copyFile(temporary, candidate, constants.COPYFILE_EXCL);
      await unlink(temporary);
      return path.relative(paths.root, candidate);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
  }
}

export function safeFilename(value: string): string {
  const base = path.basename(value).normalize("NFKC");
  const sanitized = base.replace(/[^a-zA-Z0-9._ -]+/g, "-").replace(/^[. ]+|[. ]+$/g, "").slice(0, 120);
  return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : "track.mp3";
}

function containedOutputPath(paths: JobPaths, relative: string): string {
  if (!relative || path.isAbsolute(relative)) throw new Error("Saved output path is invalid.");
  return assertPathContained(paths.outputs, path.resolve(paths.root, relative));
}

function validateTrackedJob(value: unknown, expectedId: string, paths: JobPaths): TrackedJob {
  const job = object(value, ["version", "id", "prompt", "options", "status", "history", "submission", "observationAttempts", "outputs", "error"]);
  if (job.version !== TRACKING_VERSION || job.id !== expectedId) throw new Error("Saved job state does not match this job.");
  const normalized = normalizeJob({ prompt: text(job.prompt), options: validateOptions(job.options) });
  if (jobIdentifier(normalized) !== expectedId) throw new Error("Saved job inputs do not match this job.");
  const status = validateStatus(job.status);
  if (!Array.isArray(job.history) || job.history.length === 0) throw new Error("Saved job history is invalid.");
  const history = job.history.map((entry) => {
    const item = object(entry, ["status", "at"]);
    return { status: validateStatus(item.status), at: timestamp(item.at) };
  });
  if (history.at(-1)?.status !== status) throw new Error("Saved job history is inconsistent.");
  const submissionValue = object(job.submission, ["attemptedAt", "confirmedAt", "receipt"]);
  const attemptedAt = optionalTimestamp(submissionValue.attemptedAt);
  const confirmedAt = optionalTimestamp(submissionValue.confirmedAt);
  if (confirmedAt && !attemptedAt) throw new Error("Saved submission state is inconsistent.");
  const receipt = submissionValue.receipt === undefined ? undefined : validateReceipt(submissionValue.receipt);
  if (receipt && !confirmedAt) throw new Error("Saved submission receipt is inconsistent.");
  const observationAttempts = counter(job.observationAttempts);
  if (!Array.isArray(job.outputs)) throw new Error("Saved outputs are invalid.");
  const outputs = job.outputs.map((entry) => validateOutput(entry, paths));
  const error = job.error === undefined ? undefined : validateError(job.error);
  return {
    version: TRACKING_VERSION,
    id: expectedId,
    ...normalized,
    status,
    history,
    submission: { ...(attemptedAt ? { attemptedAt } : {}), ...(confirmedAt ? { confirmedAt } : {}), ...(receipt ? { receipt } : {}) },
    observationAttempts,
    outputs,
    ...(error ? { error } : {}),
  };
}

function validateOptions(value: unknown): SunoJob["options"] {
  const options = object(value, ["instrumental", "model", "style"]);
  if (typeof options.instrumental !== "boolean") throw new Error("Saved job options are invalid.");
  return {
    instrumental: options.instrumental,
    ...(options.model === undefined ? {} : { model: text(options.model) }),
    ...(options.style === undefined ? {} : { style: text(options.style) }),
  };
}

function validateReceipt(value: unknown): SubmissionReceipt {
  const receipt = object(value, ["items"]);
  if (!Array.isArray(receipt.items) || receipt.items.length === 0 || receipt.items.length > 4) throw new Error("Saved receipt is invalid.");
  return { items: receipt.items.map((entry) => {
    const item = object(entry, ["testId", "title", "visibleId"]);
    const result = {
      ...(item.testId === undefined ? {} : { testId: boundedText(item.testId) }),
      ...(item.title === undefined ? {} : { title: boundedText(item.title) }),
      ...(item.visibleId === undefined ? {} : { visibleId: boundedText(item.visibleId) }),
    };
    if (!result.testId && !result.title && !result.visibleId) throw new Error("Saved receipt item is invalid.");
    return result;
  }) };
}

function validateOutput(value: unknown, paths: JobPaths): TrackedOutput {
  const output = object(value, ["visibleId", "title", "completedAt", "downloadAttempts", "outputPath"]);
  const outputPath = output.outputPath === undefined ? undefined : boundedText(output.outputPath);
  if (outputPath) containedOutputPath(paths, outputPath);
  return {
    visibleId: boundedText(output.visibleId),
    ...(output.title === undefined ? {} : { title: boundedText(output.title) }),
    ...(output.completedAt === undefined ? {} : { completedAt: timestamp(output.completedAt) }),
    downloadAttempts: counter(output.downloadAttempts),
    ...(outputPath ? { outputPath } : {}),
  };
}

function validateError(value: unknown): { code: string; message: string } {
  const error = object(value, ["code", "message"]);
  return { code: boundedText(error.code), message: boundedText(error.message) };
}

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Saved job state is invalid.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error("Saved job state contains unsupported fields.");
  return record;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Saved job text is invalid.");
  return value;
}

function boundedText(value: unknown): string {
  const result = text(value);
  if (result.length > 500 || /[\r\n]/.test(result)) throw new Error("Saved job text is invalid.");
  return result;
}

function timestamp(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result) || Number.isNaN(Date.parse(result))) {
    throw new Error("Saved timestamp is invalid.");
  }
  return result;
}

function optionalTimestamp(value: unknown): string | undefined {
  return value === undefined ? undefined : timestamp(value);
}

function counter(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Saved attempt counter is invalid.");
  return value as number;
}

function validateStatus(value: unknown): JobStatus {
  if (typeof value !== "string" || !JOB_STATUSES.includes(value as JobStatus)) throw new Error("Saved job status is invalid.");
  return value as JobStatus;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
