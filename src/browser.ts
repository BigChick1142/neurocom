// Browser helpers: attach to the long-running game browser (CDP) or launch one with the saved profile.
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";

export const CDP = "http://127.0.0.1:9222";
export const PLAY_URL = "https://www.conflictnations.com/play.php?bust=1";

export const isGameFrame = (f: Frame) => f.url().includes("/con-client/");
export { gameIdFromUrl } from "./bot/games.js";

export async function connect(): Promise<{ browser: Browser; page: Page; game: Frame }> {
  const browser = await chromium.connectOverCDP(CDP);
  const ctx = browser.contexts()[0];
  // With several games open, CON_GAME_ID picks which one a developer tool talks to (default: the first game tab).
  const want = process.env.CON_GAME_ID;
  const withGame = (p: Page) => p.frames().find(isGameFrame);
  const page = (want ? ctx.pages().find((p) => { const f = withGame(p); return !!f && f.url().includes("gameID=" + want); }) : undefined)
    ?? ctx.pages().find((p) => p.url().includes("play.php")) ?? ctx.pages()[0];
  const game = page.frames().find(isGameFrame) ?? page.mainFrame();
  return { browser, page, game };
}

export interface Session {
  page: Page;
  frame(): Frame | undefined;
  reload(): Promise<void>;
  close(): Promise<void>;
}

/** Attach to a running browser if there is one, otherwise launch our own on the saved profile. */
export async function openSession(): Promise<Session> {
  let ctx: BrowserContext | null = null;
  let browser: Browser | null = null;
  try {
    browser = await chromium.connectOverCDP(CDP);
    ctx = browser.contexts()[0];
  } catch {
    ctx = await chromium.launchPersistentContext("profile", {
      channel: process.env.CON_BROWSER_CHANNEL || undefined, // e.g. "chrome" or "msedge" to use the browser already installed instead of Playwright's Chromium
      headless: false,
      viewport: { width: 1600, height: 900 },
      args: ["--remote-debugging-port=9222", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
    });
  }
  let page = ctx.pages().find((p) => p.url().includes("play.php")) ?? ctx.pages()[0] ?? (await ctx.newPage());
  if (!page.url().includes("play.php")) await page.goto(PLAY_URL, { waitUntil: "domcontentloaded" });
  return {
    get page() { return page; },
    frame: () => page.frames().find(isGameFrame),
    reload: async () => {
      if (page.isClosed()) page = await ctx!.newPage();
      await page.goto(PLAY_URL, { waitUntil: "domcontentloaded" });
    },
    close: async () => { await (browser ?? ctx)!.close().catch(() => {}); },
  } as Session;
}

/** One browser (attach to a running one, else launch with the saved login). Every game the bot plays is a tab in it. */
export async function openContext(): Promise<{ ctx: BrowserContext; close(): Promise<void> }> {
  let browser: Browser | null = null;
  let ctx: BrowserContext;
  try {
    browser = await chromium.connectOverCDP(CDP);
    ctx = browser.contexts()[0];
  } catch {
    ctx = await chromium.launchPersistentContext("profile", {
      channel: process.env.CON_BROWSER_CHANNEL || undefined,
      headless: false,
      viewport: { width: 1600, height: 900 },
      args: ["--remote-debugging-port=9222", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
    });
  }
  return { ctx, close: async () => { await (browser ?? ctx).close().catch(() => {}); } };
}

/** A session bound to ONE tab (one game). Reload reloads that tab only, so the other games are untouched. */
export function sessionFor(page: Page): Session {
  return {
    get page() { return page; },
    frame: () => page.frames().find(isGameFrame),
    reload: async () => { await page.reload({ waitUntil: "domcontentloaded" }); },
    close: async () => {},
  } as Session;
}
