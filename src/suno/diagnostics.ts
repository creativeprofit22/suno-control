import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { assertPathContained } from "../config.js";
import { classifySunoLocation, createStructureLocators, SELECTOR_KEYS } from "./selectors.js";

export { SELECTOR_KEYS } from "./selectors.js";

export const DIAGNOSTIC_VERSION = 1;
export const DIAGNOSTIC_STAGES = ["launch", "navigation", "preparation", "submission", "observation", "download", "smoke"] as const;
export const DIAGNOSTIC_CATEGORIES = [
  "browser-unavailable", "navigation-failed", "login-required", "challenge-required", "validation-rejected",
  "rate-limited", "account-blocked", "changed-ui", "structure-ready", "ambiguous-result", "observation-failed", "download-failed", "unexpected",
] as const;
export type DiagnosticStage = (typeof DIAGNOSTIC_STAGES)[number];
export type DiagnosticCategory = (typeof DIAGNOSTIC_CATEGORIES)[number];
export type SelectorMatrix = Record<(typeof SELECTOR_KEYS)[number], { count: number; visible: boolean }>;

export interface RedactedDiagnostic {
  version: typeof DIAGNOSTIC_VERSION;
  timestamp: string;
  identifier: string;
  stage: DiagnosticStage;
  category: DiagnosticCategory;
  location: "create" | "login" | "suno-other" | "external" | "invalid";
  selectors: SelectorMatrix;
}

export async function probeCreateStructure(page: Page): Promise<SelectorMatrix> {
  const locators = createStructureLocators(page);
  return Object.fromEntries(await Promise.all(SELECTOR_KEYS.map(async (key) => [key, await probe(locators[key])]))) as SelectorMatrix;
}

export function classifyLocation(rawUrl: string): RedactedDiagnostic["location"] {
  const location = classifySunoLocation(rawUrl);
  if (location === "suno-create") return "create";
  if (location === "suno-login") return "login";
  return location === "unknown" ? "invalid" : location;
}

export async function createDiagnostic(
  page: Page,
  identifier: string,
  stage: DiagnosticStage,
  category: DiagnosticCategory,
  now = new Date(),
): Promise<RedactedDiagnostic> {
  return diagnostic(identifier, stage, category, classifyLocation(page.url()), await probeCreateStructure(page), now);
}

export function createUnavailableDiagnostic(
  identifier: string,
  stage: DiagnosticStage,
  category: DiagnosticCategory,
  now = new Date(),
): RedactedDiagnostic {
  const selectors = Object.fromEntries(SELECTOR_KEYS.map((key) => [key, { count: 0, visible: false }])) as SelectorMatrix;
  return diagnostic(identifier, stage, category, "invalid", selectors, now);
}

function diagnostic(
  identifier: string,
  stage: DiagnosticStage,
  category: DiagnosticCategory,
  location: RedactedDiagnostic["location"],
  selectors: SelectorMatrix,
  now: Date,
): RedactedDiagnostic {
  return validateDiagnostic({ version: DIAGNOSTIC_VERSION, timestamp: now.toISOString(), identifier, stage, category, location, selectors });
}

export async function writeDiagnostic(runtimeRoot: string, destination: string, diagnostic: RedactedDiagnostic): Promise<void> {
  validateDiagnostic(diagnostic);
  const contained = assertPathContained(runtimeRoot, destination);
  const directory = assertPathContained(runtimeRoot, path.dirname(contained));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = assertPathContained(directory, path.join(directory, `.diagnostic-${randomUUID()}.tmp`));
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, contained);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function mapDiagnosticCategory(code: string): DiagnosticCategory {
  const categories: Record<string, DiagnosticCategory> = {
    "browser-launch": "browser-unavailable",
    "navigation-failed": "navigation-failed",
    "login-required": "login-required",
    "challenge-required": "challenge-required",
    "validation-error": "validation-rejected",
    "rate-limited": "rate-limited",
    "account-blocked": "account-blocked",
    "changed-ui": "changed-ui",
    "submission-unknown": "ambiguous-result",
    "submission-unconfirmed": "ambiguous-result",
    "missing-submission-receipt": "ambiguous-result",
    "observation-exhausted": "observation-failed",
    "generation-failed": "observation-failed",
    "observation-failed": "observation-failed",
    "download-exhausted": "download-failed",
    "download-failed": "download-failed",
  };
  return categories[code] ?? "unexpected";
}

function validateDiagnostic(value: RedactedDiagnostic): RedactedDiagnostic {
  if (value.version !== DIAGNOSTIC_VERSION) throw new Error("Diagnostic version is invalid.");
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.timestamp) || Number.isNaN(Date.parse(value.timestamp))) {
    throw new Error("Diagnostic timestamp is invalid.");
  }
  if (value.identifier !== "smoke" && !/^[a-f0-9]{64}$/.test(value.identifier)) throw new Error("Diagnostic identifier is invalid.");
  if (!DIAGNOSTIC_STAGES.includes(value.stage) || !DIAGNOSTIC_CATEGORIES.includes(value.category)) throw new Error("Diagnostic classification is invalid.");
  if (!["create", "login", "suno-other", "external", "invalid"].includes(value.location)) throw new Error("Diagnostic location is invalid.");
  if (Object.keys(value.selectors).length !== SELECTOR_KEYS.length) throw new Error("Diagnostic selector matrix is invalid.");
  for (const key of SELECTOR_KEYS) {
    const entry = value.selectors[key];
    if (!entry || !Number.isSafeInteger(entry.count) || entry.count < 0 || entry.count > 10_000 || typeof entry.visible !== "boolean") {
      throw new Error("Diagnostic selector matrix is invalid.");
    }
  }
  return value;
}

async function probe(locator: Locator): Promise<{ count: number; visible: boolean }> {
  try {
    const count = await locator.count();
    return { count: Math.min(count, 10_000), visible: count > 0 && await locator.first().isVisible() };
  } catch {
    return { count: 0, visible: false };
  }
}
