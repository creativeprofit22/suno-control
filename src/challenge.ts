import { createInterface } from "node:readline/promises";

export async function waitForChallengeContinue(): Promise<void> {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  try {
    await input.question(
      "Interactive challenge detected. Complete it in Chrome, then press Enter: ",
      { signal: controller.signal },
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    input.close();
  }
}
