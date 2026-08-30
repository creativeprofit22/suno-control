import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = path.join(root, "src");
const normalize = (value) => value.split(path.sep).join("/");

async function sourceFiles(directory = sourceRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
  }));
  return nested.flat();
}

function imports(source) {
  return [...source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g)].map((match) => match[1]);
}

async function graph() {
  const files = await sourceFiles();
  const sources = new Map(await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")])));
  const edges = new Map(files.map((file) => [file, imports(sources.get(file)).filter((value) => value.startsWith(".")).map((value) => path.resolve(path.dirname(file), value.replace(/\.js$/, ".ts")))]));
  return { files, sources, edges };
}

function assertAcyclic(edges) {
  const visited = new Set();
  const active = new Set();
  const visit = (file, trail) => {
    if (active.has(file)) assert.fail(`circular dependency: ${[...trail, file].map((item) => normalize(path.relative(sourceRoot, item))).join(" -> ")}`);
    if (visited.has(file)) return;
    active.add(file);
    for (const dependency of edges.get(file) ?? []) visit(dependency, [...trail, file]);
    active.delete(file);
    visited.add(file);
  };
  for (const file of edges.keys()) visit(file, []);
}

function reachable(edges, entry) {
  const found = new Set();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop();
    if (!file || found.has(file)) continue;
    found.add(file);
    pending.push(...(edges.get(file) ?? []));
  }
  return found;
}

const zone = (file) => normalize(path.relative(sourceRoot, file)).split("/")[0];

function assertBoundaries(files, sources) {
  for (const file of files) {
    const relative = normalize(path.relative(sourceRoot, file));
    const dependencies = imports(sources.get(file));
    if (dependencies.includes("playwright")) assert.ok(relative.startsWith("suno/"), `Playwright import outside Suno adapter zone: ${relative}`);
    if (["domain", "persistence", "downloads"].includes(zone(file))) {
      assert.ok(!dependencies.some((value) => value.includes("/suno/") || value.includes("/cli/")), `inward adapter import from ${relative}`);
    }
    if (["application", "cli"].includes(zone(file))) {
      assert.ok(!dependencies.some((value) => value.includes("playwright-adapter") || value.includes("selectors")), `concrete adapter import from ${relative}`);
    }
    if (relative !== "suno/selectors.ts") {
      assert.doesNotMatch(sources.get(file), /\.(?:getByRole|getByTestId|locator)\s*\(/, `Suno locator constructed outside selectors.ts: ${relative}`);
    }
  }
}

await test("source dependency graph is acyclic and obeys zone boundaries", async () => {
  const { files, sources, edges } = await graph();
  assertAcyclic(edges);
  assertBoundaries(files, sources);
});

await test("architecture guards reject synthetic cycles and forbidden imports", () => {
  const first = path.join(sourceRoot, "domain", "first.ts");
  const second = path.join(sourceRoot, "domain", "second.ts");
  assert.throws(() => assertAcyclic(new Map([[first, [second]], [second, [first]]])), /circular dependency/);
  assert.throws(() => assertBoundaries([first], new Map([[first, 'import { chromium } from "playwright";']])), /Playwright import outside/);
  assert.throws(() => assertBoundaries([first], new Map([[first, 'page.getByRole("button")']])), /locator constructed outside/);
});

await test("non-submitting inspection cannot reach submission capability", async () => {
  const { sources, edges } = await graph();
  const entry = path.join(sourceRoot, "smoke-cli.ts");
  const reached = reachable(edges, entry);
  const names = [...reached].map((file) => normalize(path.relative(sourceRoot, file)));
  assert.ok(!names.some((name) => /submission|playwright-adapter/.test(name)), `inspection reaches submission: ${names.join(", ")}`);
  const source = [...reached].map((file) => sources.get(file)).join("\n");
  assert.doesNotMatch(source, /submitSunoJob|create(?:Button)?\s*\.click\s*\(/);
});

await test("prohibited browser techniques remain absent", async () => {
  const { sources } = await graph();
  const source = [...sources.values()].join("\n");
  for (const prohibited of [
    /storageState|\.cookies\s*\(|addCookies|connectOverCDP|remote-debugging/i,
    /page\.route|context\.route|request\.newContext|\.on\(["']request/i,
    /ignoreDefaultArgs|navigator\.webdriver|fingerprint|stealth|\bproxy\s*:/i,
    /waitForTimeout|force\s*:|\.mouse\.|\.keyboard\.type/i,
    /api\.suno|\/api\/.*generate|clerk.*token|jwt|\.tracing\.|trace\.zip/i,
  ]) assert.doesNotMatch(source, prohibited);
  assert.match(source, /channel: "chrome"/);
  assert.match(source, /chromium\.launchPersistentContext/);
});
