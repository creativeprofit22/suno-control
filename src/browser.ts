import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { RuntimePaths } from "./runtime-paths.js";

const SUNO_CREATE_URL = "https://suno.com/create";
const loginControlName = /^(sign in|sign up|log in|create account)$/i;

export async function launchSunoBrowser(paths: RuntimePaths): Promise<BrowserContext> {
  await Promise.all([
    mkdir(paths.profile, { recursive: true }),
    mkdir(paths.downloads, { recursive: true }),
  ]);

  const context = await chromium.launchPersistentContext(paths.profile, {
    headless: false,
    downloadsPath: paths.downloads,
    chromiumSandbox: true,
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(SUNO_CREATE_URL, { waitUntil: "domcontentloaded" });
    return context;
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

export async function isLoginRequired(context: BrowserContext): Promise<boolean> {
  const page = activePage(context);
  const path = new URL(page.url()).pathname.toLowerCase();
  if (/\/(?:sign-?in|sign-?up|login)(?:\/|$)/.test(path)) return true;

  const controls = page
    .getByRole("button", { name: loginControlName })
    .or(page.getByRole("link", { name: loginControlName }));
  return controls.first().isVisible();
}

function activePage(context: BrowserContext): Page {
  const pages = context.pages();
  const page = pages.at(-1);
  if (!page || page.isClosed()) throw new Error("Browser page is closed.");
  return page;
}
