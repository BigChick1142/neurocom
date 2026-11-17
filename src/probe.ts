// Autonomous probe: launch with the saved profile, open the game, screenshot, list globals.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync("captures/probe", { recursive: true });
const ctx = await chromium.launchPersistentContext("profile", {
  headless: false,
  viewport: { width: 1600, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://www.conflictnations.com/play.php?bust=1", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(15000);
await page.screenshot({ path: "captures/probe/01-lobby.png" });

const info = {
  url: page.url(),
  title: await page.title(),
  frames: page.frames().map((f) => f.url().replace(/(auth|authHash)=[^&]+/g, "$1=<r>")),
};
for (const f of page.frames()) {
  try {
    const globals = await f.evaluate(() => {
      const base = new Set(Object.getOwnPropertyNames(Object.getPrototypeOf(window)).concat(Object.getOwnPropertyNames(window)));
      const iframe = document.createElement("iframe");
      document.body.appendChild(iframe);
      const clean = new Set(Object.getOwnPropertyNames(iframe.contentWindow!));
      iframe.remove();
      return [...base].filter((k) => !clean.has(k));
    });
    (info as any)["globals:" + f.url().slice(0, 60)] = globals;
  } catch (e) {
    (info as any)["err:" + f.url().slice(0, 60)] = String(e);
  }
}
writeFileSync("captures/probe/info.json", JSON.stringify(info, null, 2));
console.log(JSON.stringify(info, null, 2).slice(0, 4000));
await ctx.close();
