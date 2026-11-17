// Long-running browser with the saved profile + CDP port 9222. Other scripts attach via connect().
import { chromium } from "playwright";
import { PLAY_URL } from "./browser.js";

const ctx = await chromium.launchPersistentContext("profile", {
  channel: process.env.CON_BROWSER_CHANNEL || undefined,
  headless: false,
  viewport: { width: 1600, height: 900 },
  args: ["--remote-debugging-port=9222", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(PLAY_URL, { waitUntil: "domcontentloaded" });
console.log("browser up; CDP on 9222");
await new Promise<void>((r) => ctx.on("close", () => r()));
