import { randomUUID } from "node:crypto";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { challengeLocators, firstVisible, loginLocators } from "./preparation.js";
import { assertPathContained, type JobPaths } from "./runtime-paths.js";
import {
  persistExclusiveOutput,
  safeFilename,
  transitionJob,
  type JobStatus,
  type ReceiptItem,
  type SubmissionReceipt,
  type TrackedJob,
  type TrackedOutput,
} from "./tracking.js";

export interface VisibleTrack {
  receipt: ReceiptItem;
  container: Locator;
  download: Locator;
  visibleId: string;
  title?: string;
}

export type CompletionObservation =
  | { status: "queued" | "running" }
  | { status: "completed"; tracks: VisibleTrack[] }
  | { status: "failed" | "blocked" | "unknown"; error: { code: string; message: string } };

export interface DownloadLimits {
  maxAttempts: number;
  timeoutMs: number;
}

export interface ObservationLimits {
  maxAttempts: number;
  initialAttempts?: number;
  deadlineMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function observeCompletion(
  page: Page,
  receipt: SubmissionReceipt,
  limits: ObservationLimits,
  onObservation: (observation: CompletionObservation, attempt: number) => Promise<void>,
): Promise<CompletionObservation> {
  const now = limits.now ?? Date.now;
  const sleep = limits.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const initialAttempts = limits.initialAttempts ?? 0;

  for (let attempt = initialAttempts + 1; attempt <= limits.maxAttempts && now() - startedAt <= limits.deadlineMs; attempt += 1) {
    const observation = await classifyVisibleCompletion(page, receipt);
    await onObservation(observation, attempt);
    if (observation.status !== "queued" && observation.status !== "running") return observation;
    if (attempt < limits.maxAttempts && now() - startedAt < limits.deadlineMs) await sleep(limits.intervalMs);
  }

  const exhausted: CompletionObservation = {
    status: "unknown",
    error: {
      code: "observation-exhausted",
      message: "Tracking stopped at its retry limit. Inspect the visible browser, then rerun this job.",
    },
  };
  await onObservation(exhausted, Math.min(limits.maxAttempts, Math.max(initialAttempts, 1)));
  return exhausted;
}

export async function classifyVisibleCompletion(
  page: Page,
  receipt: SubmissionReceipt,
): Promise<CompletionObservation> {
  if (await firstVisible(loginLocators(page))) {
    return blocked("login-required", "Sign in within the visible browser, then rerun this job.");
  }
  if (await firstVisible(challengeLocators(page))) {
    return blocked("challenge-required", "Complete the visible browser challenge, then rerun this job.");
  }

  const containers = await reacquireReceipt(page, receipt);
  if (!containers) return unknown("receipt-not-found", "The submitted tracks could not be matched exactly. Inspect the visible browser.");

  const completed: VisibleTrack[] = [];
  let queued = false;
  let running = false;
  for (let index = 0; index < containers.length; index += 1) {
    const container = containers[index]!;
    const item = receipt.items[index]!;
    const failure = container.getByTestId("generation-failed").or(
      container.getByRole("alert").filter({ hasText: /failed|error|restricted|rate limit|not enough credits/i }),
    );
    const queuedMarker = container.getByRole("status").filter({ hasText: /queued|waiting|pending/i });
    const runningMarker = container.getByRole("status").filter({ hasText: /creating|generating|running/i }).or(
      container.getByRole("progressbar"),
    );
    const download = container.getByRole("button", { name: /^download(?: audio)?$/i }).or(
      container.getByRole("link", { name: /^download(?: audio)?$/i }),
    );
    const states = [
      await failure.first().isVisible(),
      await queuedMarker.first().isVisible(),
      await runningMarker.first().isVisible(),
      await download.first().isVisible() && await download.first().isEnabled(),
    ];
    if (states.filter(Boolean).length !== 1) {
      return unknown("ambiguous-track-state", "A submitted track has an unknown or contradictory visible state.");
    }
    if (states[0]) {
      return { status: "failed", error: { code: "generation-failed", message: "Suno visibly rejected this generation. Review account limits before retrying." } };
    }
    if (states[1]) queued = true;
    if (states[2]) running = true;
    if (states[3]) {
      const title = await visibleTitle(container, item);
      const visibleId = item.visibleId ?? title ?? item.testId;
      if (!visibleId) return unknown("missing-track-identity", "A completed track has no stable visible identifier.");
      completed.push({ receipt: item, container, download: download.first(), visibleId, ...(title ? { title } : {}) });
    }
  }

  if (new Set(completed.map((track) => track.visibleId)).size !== completed.length) {
    return unknown("ambiguous-track-identity", "Completed tracks do not expose unique visible identifiers.");
  }
  if (completed.length === containers.length) return { status: "completed", tracks: completed };
  if (running || completed.length > 0) return { status: "running" };
  if (queued) return { status: "queued" };
  return unknown("unknown-track-state", "The submitted tracks do not expose a recognized visible state.");
}

export async function reacquireReceipt(page: Page, receipt: SubmissionReceipt): Promise<Locator[] | undefined> {
  const groups = page.getByRole("table").getByRole("group");
  const matches: Locator[] = [];
  for (const item of receipt.items) {
    let candidate = groups;
    if (item.testId) candidate = candidate.and(page.getByTestId(item.testId));
    if (item.visibleId) candidate = candidate.and(page.getByRole("group", { name: item.visibleId, exact: true }));
    if (item.title) {
      const title = page.getByRole("heading", { name: item.title, exact: true }).or(
        page.getByRole("link", { name: item.title, exact: true }),
      );
      candidate = candidate.filter({ has: title });
    }
    if (await candidate.count() !== 1 || !(await candidate.isVisible())) return undefined;
    const handle = await candidate.elementHandle();
    if (!handle) return undefined;
    for (const existing of matches) {
      const existingHandle = await existing.elementHandle();
      if (existingHandle && await page.evaluate(([left, right]) => left === right, [handle, existingHandle])) return undefined;
    }
    matches.push(candidate);
  }
  return matches;
}

export async function downloadCompletedTracks(
  page: Page,
  paths: JobPaths,
  job: TrackedJob,
  tracks: VisibleTrack[],
  limits: DownloadLimits,
  saveState: (job: TrackedJob) => Promise<void>,
  now = () => new Date(),
): Promise<TrackedJob> {
  let current = job;
  await mkdir(paths.outputs, { recursive: true, mode: 0o700 });

  for (const track of tracks) {
    let output = current.outputs.find((candidate) => candidate.visibleId === track.visibleId) ?? {
      visibleId: track.visibleId,
      ...(track.title ? { title: track.title } : {}),
      downloadAttempts: 0,
    };
    if (await outputExists(paths, output)) continue;

    let saved = false;
    while (output.downloadAttempts < limits.maxAttempts) {
      output = { ...output, downloadAttempts: output.downloadAttempts + 1 };
      current = replaceOutput(current, output);
      await saveState(current);
      const temporary = assertPathContained(paths.outputs, path.join(paths.outputs, `.download-${randomUUID()}.tmp`));
      try {
        const downloadPromise = page.waitForEvent("download", { timeout: limits.timeoutMs });
        const [clickResult, downloadResult] = await Promise.allSettled([track.download.click(), downloadPromise]);
        if (clickResult.status === "rejected" || downloadResult.status === "rejected") throw new Error("Browser download failed.");
        const download = downloadResult.value;
        if (await download.failure()) throw new Error("Browser download failed.");
        await download.saveAs(temporary);
        const suggested = safeFilename(download.suggestedFilename());
        const extension = /^\.[a-zA-Z0-9]{1,8}$/.test(path.extname(suggested)) ? path.extname(suggested) : ".mp3";
        const stem = path.parse(safeFilename(track.title ?? track.visibleId)).name || "track";
        const outputPath = await persistExclusiveOutput(paths, temporary, `${stem}${extension}`);
        output = { ...output, completedAt: now().toISOString(), outputPath };
        current = replaceOutput(current, output);
        await saveState(current);
        saved = true;
        break;
      } catch {
        await unlink(temporary).catch(() => undefined);
      }
    }

    if (!saved) {
      current = transitionJob(current, "unknown", now(), {
        code: "download-exhausted",
        message: "Downloading stopped at its retry limit. Inspect the visible browser, then rerun this job.",
      });
      await saveState(current);
      return current;
    }
  }

  current = transitionJob(current, "completed", now());
  await saveState(current);
  return current;
}

export function statusForObservation(observation: CompletionObservation): JobStatus {
  return observation.status;
}

async function outputExists(paths: JobPaths, output: TrackedOutput): Promise<boolean> {
  if (!output.outputPath) return false;
  const candidate = assertPathContained(paths.outputs, path.resolve(paths.root, output.outputPath));
  try {
    return (await stat(candidate)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function replaceOutput(job: TrackedJob, output: TrackedOutput): TrackedJob {
  const index = job.outputs.findIndex((candidate) => candidate.visibleId === output.visibleId);
  const outputs = index < 0 ? [...job.outputs, output] : job.outputs.map((candidate, current) => current === index ? output : candidate);
  return { ...job, outputs };
}

async function visibleTitle(container: Locator, item: ReceiptItem): Promise<string | undefined> {
  if (item.title) return item.title;
  const heading = container.getByRole("heading").first();
  const link = container.getByRole("link").first();
  const text = await (await heading.isVisible() ? heading : link).textContent();
  const cleaned = text?.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 500) : undefined;
}

function blocked(code: string, message: string): CompletionObservation {
  return { status: "blocked", error: { code, message } };
}

function unknown(code: string, message: string): CompletionObservation {
  return { status: "unknown", error: { code, message } };
}
