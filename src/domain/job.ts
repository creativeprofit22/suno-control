import { createHash } from "node:crypto";

export interface GenerationOptions {
  style?: string;
  model?: string;
  instrumental: boolean;
}

export interface SunoJob {
  prompt: string;
  options: GenerationOptions;
}

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
  options: GenerationOptions;
  status: JobStatus;
  history: Array<{ status: JobStatus; at: string }>;
  submission: { attemptedAt?: string; confirmedAt?: string; receipt?: SubmissionReceipt };
  observationAttempts: number;
  outputs: TrackedOutput[];
  error?: { code: string; message: string };
}

export type ResumeAction = "submit" | "observe" | "complete" | "review";

export function normalizeJob(job: SunoJob): SunoJob {
  if (!job || typeof job.prompt !== "string") throw new Error("Job prompt is invalid.");
  const prompt = requiredText(job.prompt, "prompt");
  const options = exactObject(job.options, ["instrumental", "model", "style"], "Job options are invalid.");
  if (typeof options.instrumental !== "boolean") throw new Error("Job options are invalid.");
  const model = optionalText(options.model, "model");
  const style = optionalText(options.style, "style");
  return {
    prompt,
    options: {
      instrumental: options.instrumental,
      ...(model === undefined ? {} : { model }),
      ...(style === undefined ? {} : { style }),
    },
  };
}

export function jobIdentifier(job: SunoJob): string {
  return createHash("sha256").update(JSON.stringify(normalizeJob(job))).digest("hex");
}

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

export function validateTrackedJob(value: unknown, expectedId: string): TrackedJob {
  const job = exactObject(value, ["version", "id", "prompt", "options", "status", "history", "submission", "observationAttempts", "outputs", "error"], "Saved job state is invalid.");
  if (job.version !== TRACKING_VERSION || job.id !== expectedId) throw new Error("Saved job state does not match this job.");
  const normalized = normalizeJob({ prompt: text(job.prompt), options: validateOptions(job.options) });
  if (jobIdentifier(normalized) !== expectedId) throw new Error("Saved job inputs do not match this job.");
  const status = validateStatus(job.status);
  if (!Array.isArray(job.history) || job.history.length === 0) throw new Error("Saved job history is invalid.");
  const history = job.history.map((entry) => {
    const item = exactObject(entry, ["status", "at"], "Saved job state is invalid.");
    return { status: validateStatus(item.status), at: timestamp(item.at) };
  });
  if (history.at(-1)?.status !== status) throw new Error("Saved job history is inconsistent.");
  const submissionValue = exactObject(job.submission, ["attemptedAt", "confirmedAt", "receipt"], "Saved job state is invalid.");
  const attemptedAt = optionalTimestamp(submissionValue.attemptedAt);
  const confirmedAt = optionalTimestamp(submissionValue.confirmedAt);
  if (confirmedAt && !attemptedAt) throw new Error("Saved submission state is inconsistent.");
  const receipt = submissionValue.receipt === undefined ? undefined : validateReceipt(submissionValue.receipt);
  if (receipt && !confirmedAt) throw new Error("Saved submission receipt is inconsistent.");
  if (!Array.isArray(job.outputs)) throw new Error("Saved outputs are invalid.");
  const outputs = job.outputs.map(validateOutput);
  const error = job.error === undefined ? undefined : validateError(job.error);
  return {
    version: TRACKING_VERSION,
    id: expectedId,
    ...normalized,
    status,
    history,
    submission: { ...(attemptedAt ? { attemptedAt } : {}), ...(confirmedAt ? { confirmedAt } : {}), ...(receipt ? { receipt } : {}) },
    observationAttempts: counter(job.observationAttempts),
    outputs,
    ...(error ? { error } : {}),
  };
}

function validateOptions(value: unknown): GenerationOptions {
  const options = exactObject(value, ["instrumental", "model", "style"], "Saved job options are invalid.");
  if (typeof options.instrumental !== "boolean") throw new Error("Saved job options are invalid.");
  return {
    instrumental: options.instrumental,
    ...(options.model === undefined ? {} : { model: text(options.model) }),
    ...(options.style === undefined ? {} : { style: text(options.style) }),
  };
}

function validateReceipt(value: unknown): SubmissionReceipt {
  const receipt = exactObject(value, ["items"], "Saved receipt is invalid.");
  if (!Array.isArray(receipt.items) || receipt.items.length === 0 || receipt.items.length > 4) throw new Error("Saved receipt is invalid.");
  return { items: receipt.items.map((entry) => {
    const item = exactObject(entry, ["testId", "title", "visibleId"], "Saved receipt is invalid.");
    const result = {
      ...(item.testId === undefined ? {} : { testId: boundedText(item.testId) }),
      ...(item.title === undefined ? {} : { title: boundedText(item.title) }),
      ...(item.visibleId === undefined ? {} : { visibleId: boundedText(item.visibleId) }),
    };
    if (!result.testId && !result.title && !result.visibleId) throw new Error("Saved receipt item is invalid.");
    return result;
  }) };
}

function validateOutput(value: unknown): TrackedOutput {
  const output = exactObject(value, ["visibleId", "title", "completedAt", "downloadAttempts", "outputPath"], "Saved outputs are invalid.");
  return {
    visibleId: boundedText(output.visibleId),
    ...(output.title === undefined ? {} : { title: boundedText(output.title) }),
    ...(output.completedAt === undefined ? {} : { completedAt: timestamp(output.completedAt) }),
    downloadAttempts: counter(output.downloadAttempts),
    ...(output.outputPath === undefined ? {} : { outputPath: boundedText(output.outputPath) }),
  };
}

function validateError(value: unknown): { code: string; message: string } {
  const error = exactObject(value, ["code", "message"], "Saved job state is invalid.");
  return { code: boundedText(error.code), message: boundedText(error.message) };
}

function exactObject(value: unknown, allowed: readonly string[], message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw new Error("Saved job state contains unsupported fields.");
  return record;
}

function requiredText(value: unknown, name: string): string {
  const result = optionalText(value, name);
  if (result === undefined) throw new Error(`Option --${name} is required.`);
  return result;
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Option --${name} must be text.`);
  const result = value.trim();
  if (!result) throw new Error(`Option --${name} must not be blank.`);
  return result;
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
