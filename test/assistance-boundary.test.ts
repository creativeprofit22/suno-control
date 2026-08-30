import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { API, type Program } from "typescript/unstable/sync";
import {
  SyntaxKind,
  type ImportClause,
  type Node,
  type SourceFile,
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isNamedExports,
  isNamedImports,
  isStringLiteralLikeNode,
} from "typescript/unstable/ast";

const root = fileURLToPath(new URL("../..", import.meta.url));
const sourceRoot = path.join(root, "src");
const forbiddenAccountActionModules = [
  "suno/selectors.ts", "suno/preparation.ts", "suno/submission.ts", "suno/completion.ts",
  "suno/diagnostics.ts", "suno/playwright-adapter.ts", "application/run-jobs.ts",
  "cli/presentation.ts", "persistence/", "downloads/",
];

const importClauseHasRuntimeValue = (clause: ImportClause | undefined): boolean => {
  if (clause === undefined) return true;
  if (clause.phaseModifier === SyntaxKind.TypeKeyword) return false;
  if (clause.name !== undefined || clause.namedBindings === undefined || !isNamedImports(clause.namedBindings)) return true;
  return clause.namedBindings.elements.length === 0 || clause.namedBindings.elements.some((element) => !element.isTypeOnly);
};

function runtimeDependencies(sourceFile: SourceFile): string[] {
  const dependencies: string[] = [];
  const visit = (node: Node): void => {
    if (isImportDeclaration(node) && importClauseHasRuntimeValue(node.importClause)) {
      assert.ok(isStringLiteralLikeNode(node.moduleSpecifier), `non-literal static import in ${sourceFile.fileName}`);
      dependencies.push(node.moduleSpecifier.text);
    } else if (isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier !== undefined) {
      const hasRuntimeValue = node.exportClause === undefined || !isNamedExports(node.exportClause)
        || node.exportClause.elements.length === 0 || node.exportClause.elements.some((element) => !element.isTypeOnly);
      if (hasRuntimeValue) {
        assert.ok(isStringLiteralLikeNode(node.moduleSpecifier), `non-literal static export in ${sourceFile.fileName}`);
        dependencies.push(node.moduleSpecifier.text);
      }
    } else if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      const specifier = node.arguments[0];
      assert.ok(specifier !== undefined && isStringLiteralLikeNode(specifier),
        `assisted dependency graph contains non-literal dynamic import in ${sourceFile.fileName}`);
      dependencies.push(specifier.text);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return dependencies;
}

function localDependency(file: string, specifier: string, graphSourceRoot: string): string | undefined {
  if (!specifier.startsWith(".")) {
    assert.ok(!path.isAbsolute(specifier) && !specifier.startsWith("file:"),
      `assisted dependency graph contains unsupported absolute import: ${specifier}`);
    return undefined;
  }
  const dependency = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts"));
  const relative = path.relative(graphSourceRoot, dependency);
  assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `assisted dependency escapes src: ${specifier}`);
  return dependency;
}

async function assistedRuntimeSources(projectRoot = root): Promise<Map<string, string>> {
  const graphSourceRoot = path.join(projectRoot, "src");
  const config = path.join(projectRoot, "tsconfig.json");
  const api = new API();
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      assert.ok(project, `TypeScript could not load ${config}`);
      return walkAssistedRuntime(project.program, graphSourceRoot);
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

function walkAssistedRuntime(program: Program, graphSourceRoot: string): Map<string, string> {
  const sources = new Map<string, string>();
  const pending = [path.join(graphSourceRoot, "assist-cli.ts")];
  while (pending.length > 0) {
    const file = pending.pop();
    assert.ok(file);
    if (sources.has(file)) continue;
    const sourceFile = program.getSourceFile(file);
    assert.ok(sourceFile, `assisted dependency is not a TypeScript source file: ${file}`);
    sources.set(file, sourceFile.text);
    for (const specifier of runtimeDependencies(sourceFile)) {
      const dependency = localDependency(file, specifier, graphSourceRoot);
      if (dependency !== undefined) pending.push(dependency);
    }
  }
  return sources;
}

function assertNoAccountActionModules(sources: Map<string, string>, graphSourceRoot = sourceRoot): void {
  const relativeFiles = [...sources.keys()].map((file) => path.relative(graphSourceRoot, file).replaceAll("\\", "/"));
  for (const fragment of forbiddenAccountActionModules) {
    assert.ok(!relativeFiles.some((file) => file.includes(fragment)), `assisted dependency graph reaches ${fragment}`);
  }
}

test("assisted runtime dependency graph cannot reach account-action modules", async () => {
  assertNoAccountActionModules(await assistedRuntimeSources());
});

async function withSyntheticAssistedProject(
  entrySource: string,
  assertion: (projectRoot: string) => Promise<void>,
): Promise<void> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "suno-assistance-boundary-"));
  try {
    await mkdir(path.join(projectRoot, "src", "suno"), { recursive: true });
    await Promise.all([
      writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({ include: ["src/**/*.ts"] })),
      writeFile(path.join(projectRoot, "src", "assist-cli.ts"), entrySource),
      writeFile(path.join(projectRoot, "src", "suno", "submission.ts"), "export const submit = true;\n"),
    ]);
    await assertion(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("assisted dependency walker detects synthetic runtime re-exports and dynamic imports", async (context) => {
  for (const [name, entrySource] of [
    ["export star", 'export * from "./suno/submission.js";'],
    ["dynamic import", 'void import("./suno/submission.js");'],
  ] as const) {
    await context.test(name, async () => withSyntheticAssistedProject(entrySource, async (projectRoot) => {
      const sources = await assistedRuntimeSources(projectRoot);
      assert.throws(() => assertNoAccountActionModules(sources, path.join(projectRoot, "src")), /submission/);
    }));
  }
});

test("assisted dependency walker rejects non-literal dynamic imports", async () => {
  await withSyntheticAssistedProject('const target = "./suno/submission.js"; void import(target);', async (projectRoot) => {
    await assert.rejects(assistedRuntimeSources(projectRoot), /non-literal dynamic import/);
  });
});

test("assisted runtime source contains no submission, observation, or key-event capability", async () => {
  const sources = await assistedRuntimeSources();
  const source = [...sources.values()].join("\n");

  for (const forbidden of [
    /Create song/i,
    /submitSunoJob|submissionResultLocators|resultContainers|receiptCandidate|trackStateLocators/,
    /downloadControl|waitForEvent\s*\(\s*["']download["']/,
    /\bkeyboard\b|\.press\s*\(|pressSequentially|dispatchEvent\s*\([^)]*(?:key|enter)/i,
    /observeCompletion|observeResults|saveDownload/,
  ]) assert.doesNotMatch(source, forbidden);
});

test("assisted field capability exposes only explicit click, fill, and visibility operations", async () => {
  const source = await readFile(path.join(sourceRoot, "suno", "assistance.ts"), "utf8");
  const interfaceSource = source.slice(source.indexOf("type ClickControl"), source.indexOf("const requiredControls"));

  assert.match(interfaceSource, /Pick<Locator, "click" \| "count" \| "isVisible">/);
  assert.match(interfaceSource, /Pick<Locator, "fill" \| "count" \| "isVisible">/);
  assert.doesNotMatch(interfaceSource, /Page|Browser|press|dispatch|evaluate|request|response|download|result/i);
});

test("assist package script targets only the isolated assisted entry point", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(packageJson.scripts.assist ?? "", /node dist\/src\/assist-cli\.js$/);
  assert.doesNotMatch(packageJson.scripts.assist ?? "", /main\.js|smoke-cli\.js/);
});
