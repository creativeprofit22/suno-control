import path from "node:path";

export interface RuntimePaths {
  root: string;
  profile: string;
  downloads: string;
}

export function resolveRuntimePaths(projectRoot: string): RuntimePaths {
  const root = path.resolve(projectRoot, ".suno-control");
  const profile = assertPathContained(root, path.resolve(root, "browser-profile"));
  const downloads = assertPathContained(root, path.resolve(root, "downloads"));
  return { root, profile, downloads };
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
