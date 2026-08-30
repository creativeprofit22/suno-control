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

test("operator guide defines assisted mode's manual-only safety boundary", () => {
  for (const required of [
    "npm run assist", "1,000 ms", "75 ms", "click \\*\\*Create\\*\\* manually", "Terminal input is never sent",
    "Close the dedicated browser", "does not authorize", "Suno terms", "account action",
  ]) assert.match(readme, new RegExp(required, "i"));
});