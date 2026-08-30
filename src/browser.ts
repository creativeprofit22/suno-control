import { mkdir } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { RuntimePaths } from "./runtime-paths.js";

export const SUNO_CREATE_URL = "https://suno.com/create";
const loginControlName = /^(sign in|sign up|log in|create account)$/i;

export interface SunoBrowser {
  context: BrowserContext;
  page: Page;
}

export async function launchSunoBrowser(paths: RuntimePaths): Promise<SunoBrowser> {
  await Promise.all([
    mkdir(paths.profile, { recursive: true }),
    mkdir(paths.downloads, { recursive: true }),
  ]);

  const context = await chromium.launchPersistentContext(paths.profile, {
    channel: "chrome",
    headless: false,
    downloadsPath: paths.downloads,
    chromiumSandbox: true,
  });

  try {
    const page = await openSunoPage(context, context.pages()[0]);
    return { context, page };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

export async function openSunoPage(context: BrowserContext, existing?: Page): Promise<Page> {
  const page = existing ?? await context.newPage();
  try {
    await page.goto(SUNO_CREATE_URL, { waitUntil: "domcontentloaded" });
    return page;
  } catch (error) {
    if (!existing) await page.close().catch(() => undefined);
    throw error;
  }
}

export async function isLoginRequired(page: Page): Promise<boolean> {
  const path = new URL(page.url()).pathname.toLowerCase();
  if (/\/(?:sign-?in|sign-?up|login)(?:\/|$)/.test(path)) return true;

  const controls = page
    .getByRole("button", { name: loginControlName })
    .or(page.getByRole("link", { name: loginControlName }));
  return controls.first().isVisible();
}
