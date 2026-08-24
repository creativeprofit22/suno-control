import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserContext } from "playwright";
import { runBrowserSession } from "../src/cli.js";

test("SIGTERM requests browser cleanup before the session ends", async () => {
  const baselineSigtermListeners = process.listenerCount("SIGTERM");
  let closeCalls = 0;
  const context = {
    close: async () => {
      closeCalls += 1;
    },
  } as unknown as BrowserContext;

  setImmediate(() => process.emit("SIGTERM", "SIGTERM"));
  await runBrowserSession(context, async () => false);

  assert.equal(closeCalls, 1);
  assert.equal(process.listenerCount("SIGTERM"), baselineSigtermListeners);
});
