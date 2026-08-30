import { pathToFileURL } from "node:url";
import { runCli } from "./cli/presentation.js";
import { resolveRuntimePaths } from "./config.js";
import { LocalOutputStore } from "./downloads/local-output-store.js";
import { LocalJobRepository } from "./persistence/local-job-repository.js";
import { PlaywrightSunoAdapter } from "./suno/playwright-adapter.js";

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const paths = resolveRuntimePaths(process.cwd());
  const repository = new LocalJobRepository(paths);
  const outputs = new LocalOutputStore(paths);
  const automation = new PlaywrightSunoAdapter(paths, repository, outputs);
  return runCli(args, { repository, automation, paths });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
