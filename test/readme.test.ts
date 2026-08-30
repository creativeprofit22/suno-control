import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");

test("operator guide covers queue recovery and account-risk workflow", () => {
  for (const required of [
    "--jobs", "--concurrency", "--retries", "Authenticate and reset", "challenge", "Rerunning identical",
    "Redacted diagnostics", "smoke:live", "account blocks", "Never use your normal Chrome profile",
  ]) assert.match(readme, new RegExp(required, "i"));
});
