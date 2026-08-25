import path from "node:path";

export interface RuntimePaths {
  root: string;
  profile: string;
  downloads: string;
  smokeScreenshot: string;
  smokeOutcome: string;
}

export function resolveRuntimePaths(projectRoot: string): RuntimePaths {
  const root = path.resolve(projectRoot, ".suno-control");
  const profile = assertPathContained(root, path.resolve(root, "chrome-profile"));
  const downloads = assertPathContained(root, path.resolve(root, "downloads"));
  const smokeScreenshot = assertPathContained(root, path.resolve(root, "smoke", "live-smoke.png"));
  const smokeOutcome = assertPathContained(root, path.resolve(root, "smoke", "outcome.json"));
  return { root, profile, downloads, smokeScreenshot, smokeOutcome };
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
