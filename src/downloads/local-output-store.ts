import { constants, copyFile, lstat, mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { OutputStore, TemporaryOutput } from "../application/contracts.js";
import { assertPathContained, resolveJobPaths, type RuntimePaths } from "../config.js";

export class LocalOutputStore implements OutputStore {
  constructor(private readonly paths: RuntimePaths) {}

  async exists(jobId: string, relativePath: string): Promise<boolean> {
    try {
      return (await stat(this.outputPath(jobId, relativePath))).isFile();
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  async persist(jobId: string, output: TemporaryOutput): Promise<string> {
    const temporary = assertPathContained(this.paths.downloads, path.resolve(output.path));
    const source = await lstat(temporary);
    if (!source.isFile() || source.isSymbolicLink()) throw new Error("Temporary download is invalid.");
    const paths = resolveJobPaths(this.paths, jobId);
    await mkdir(paths.outputs, { recursive: true, mode: 0o700 });
    const parsed = path.parse(safeFilename(output.suggestedName));
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

  private outputPath(jobId: string, relative: string): string {
    const paths = resolveJobPaths(this.paths, jobId);
    if (!relative || path.isAbsolute(relative)) throw new Error("Saved output path is invalid.");
    return assertPathContained(paths.outputs, path.resolve(paths.root, relative));
  }
}

export function safeFilename(value: string): string {
  const base = path.basename(value).normalize("NFKC");
  const sanitized = base.replace(/[^a-zA-Z0-9._ -]+/g, "-").replace(/^[. ]+|[. ]+$/g, "").slice(0, 120);
  return sanitized && sanitized !== "." && sanitized !== ".." ? sanitized : "track.mp3";
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
