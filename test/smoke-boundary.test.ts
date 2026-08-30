import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sourceRoot = path.join(root, "src");

async function smokeSources(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();
  const pending = [path.join(sourceRoot, "smoke-cli.ts")];

  while (pending.length > 0) {
    const file = pending.pop();
    assert.ok(file);
    if (sources.has(file)) continue;

    const source = await readFile(file, "utf8");
    sources.set(file, source);
    for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g)) {
      const dependency = match[1];
      assert.ok(dependency);
      pending.push(path.resolve(path.dirname(file), dependency.replace(/\.js$/, ".ts")));
    }
  }

  return sources;
}

test("live smoke dependency path has no submission capability", async () => {
  const sources = await smokeSources();
  const relativeFiles = [...sources.keys()].map((file) => path.relative(sourceRoot, file));
  const source = [...sources.values()].join("\n");

  assert.ok(!relativeFiles.some((file) => file.endsWith("submission.ts")), "smoke dependency graph reaches submission.ts");
  assert.doesNotMatch(source, /submitSunoJob|createButton\s*\.click/);
  for (const dependency of sources.values()) assert.doesNotMatch(dependency, /Create song[\s\S]{0,120}\.click\s*\(/);
  assert.match(
    JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).scripts["smoke:live"],
    /smoke-cli\.js$/,
  );
});