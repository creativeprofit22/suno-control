import assert from "node:assert/strict";
import test from "node:test";
import { parseSunoJob } from "../src/job.js";

test("parses a complete Suno job", () => {
  assert.deepEqual(
    parseSunoJob([
      "--prompt", "  quiet rain  ",
      "--style", " ambient ",
      "--model", " current-model ",
      "--instrumental",
    ]),
    {
      prompt: "quiet rain",
      options: { style: "ambient", model: "current-model", instrumental: true },
    },
  );
});

test("parses required input with defaults", () => {
  assert.deepEqual(parseSunoJob(["--prompt", "song"]), {
    prompt: "song",
    options: { instrumental: false },
  });
});

for (const [name, args] of [
  ["missing prompt", []],
  ["blank prompt", ["--prompt", "   "]],
  ["blank style", ["--prompt", "song", "--style", " "]],
  ["blank model", ["--prompt", "song", "--model", " "]],
  ["unknown option", ["--prompt", "song", "--other", "value"]],
  ["duplicate scalar option", ["--prompt", "one", "--prompt", "two"]],
  ["positional input", ["--prompt", "song", "extra"]],
] as const) {
  test(`rejects ${name}`, () => {
    assert.throws(() => parseSunoJob(args));
  });
}
