import path from "node:path";

export const MINIMUM_NODE_MAJOR = 22;
export const SUNO_ORIGIN = "https://suno.com";
export const SUNO_CREATE_URL = `${SUNO_ORIGIN}/create`;
export const ACTION_TIMEOUT_MS = 10_000;
export const RESULT_TIMEOUT_MS = 5_000;
export const DEFAULT_OBSERVATION_LIMITS = { maxAttempts: 120, deadlineMs: 30 * 60_000, intervalMs: 15_000 } as const;
export const DEFAULT_DOWNLOAD_LIMITS = { maxAttempts: 3, timeoutMs: 60_000 } as const;

export interface RuntimePaths {
  root: string;
  profile: string;
  downloads: string;
  jobs: string;
  smokeScreenshot: string;
  smokeOutcome: string;
}

export interface JobPaths {
  root: string;
  state: string;
  outputs: string;
  diagnostic: string;
}

export function resolveRuntimePaths(projectRoot: string): RuntimePaths {
  const root = path.resolve(projectRoot, ".suno-control");
  return {
    root,
    profile: assertPathContained(root, path.resolve(root, "chrome-profile")),
    downloads: assertPathContained(root, path.resolve(root, "downloads")),
    jobs: assertPathContained(root, path.resolve(root, "jobs")),
    smokeScreenshot: assertPathContained(root, path.resolve(root, "smoke", "live-smoke.png")),
    smokeOutcome: assertPathContained(root, path.resolve(root, "smoke", "outcome.json")),
  };
}

export function resolveJobPaths(paths: RuntimePaths, identifier: string): JobPaths {
  if (!/^[a-f0-9]{64}$/.test(identifier)) throw new Error("Job identifier is invalid.");
  const root = assertPathContained(paths.jobs, path.resolve(paths.jobs, identifier));
  return {
    root,
    state: assertPathContained(root, path.resolve(root, "state.json")),
    outputs: assertPathContained(root, path.resolve(root, "outputs")),
    diagnostic: assertPathContained(root, path.resolve(root, "diagnostic.json")),
  };
}

export function assertPathContained(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Runtime path must remain inside the application runtime directory.");
  }
  return resolvedCandidate;
}
