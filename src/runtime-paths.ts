import path from "node:path";

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
  const profile = assertPathContained(root, path.resolve(root, "chrome-profile"));
  const downloads = assertPathContained(root, path.resolve(root, "downloads"));
  const jobs = assertPathContained(root, path.resolve(root, "jobs"));
  const smokeScreenshot = assertPathContained(root, path.resolve(root, "smoke", "live-smoke.png"));
  const smokeOutcome = assertPathContained(root, path.resolve(root, "smoke", "outcome.json"));
  return { root, profile, downloads, jobs, smokeScreenshot, smokeOutcome };
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
