import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { JobRepository } from "../application/contracts.js";
import { assertPathContained, resolveJobPaths, type JobPaths, type RuntimePaths } from "../config.js";
import { validateTrackedJob, type TrackedJob } from "../domain/job.js";

export class LocalJobRepository implements JobRepository {
  constructor(private readonly paths: RuntimePaths) {}

  async load(id: string): Promise<TrackedJob | undefined> {
    const paths = this.jobPaths(id);
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
    const job = validateTrackedJob(value, id);
    for (const output of job.outputs) if (output.outputPath) this.outputPath(paths, output.outputPath);
    return job;
  }

  async save(job: TrackedJob): Promise<void> {
    validateTrackedJob(job, job.id);
    const paths = this.jobPaths(job.id);
    for (const output of job.outputs) if (output.outputPath) this.outputPath(paths, output.outputPath);
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

  async outputsExist(job: TrackedJob): Promise<boolean> {
    const paths = this.jobPaths(job.id);
    if (job.outputs.length === 0 || job.outputs.some((output) => !output.outputPath)) return false;
    for (const output of job.outputs) {
      try {
        if (!(await stat(this.outputPath(paths, output.outputPath!))).isFile()) return false;
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return false;
        throw error;
      }
    }
    return true;
  }

  jobPaths(id: string): JobPaths {
    return resolveJobPaths(this.paths, id);
  }

  private outputPath(paths: JobPaths, relative: string): string {
    if (!relative || path.isAbsolute(relative)) throw new Error("Saved output path is invalid.");
    return assertPathContained(paths.outputs, path.resolve(paths.root, relative));
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
