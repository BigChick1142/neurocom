// Read-only check of the Settings tab: sliders render, the look controls work, no page errors. npx tsx tools/settings-ui-test.ts [outfile.png]
import { chromium } from "playwright";
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errs: string[] = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.addInitScript(() => { try { localStorage.setItem("tab", "settings"); } catch { /* */ } });
await p.goto("http://127.0.0.1:8787/", { waitUntil: "domcontentloaded" });
await p.waitForSelector(".sl", { timeout: 15000 });
const n = await p.locator('input[type=range]').count();
const before = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent"));
await p.click('[data-accent="violet"]');
await p.click('[data-density="compact"]');
await p.click('[data-tabvis="brain"]');
const after = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
const tabs = await p.locator('#tabs .tab').count();
// moving a slider updates its label live (input event only: nothing is saved, no change event)
const lab = await p.evaluate(() => { const r = document.querySelector('input[data-num="maxWars"]') as HTMLInputElement; r.value = "5"; r.dispatchEvent(new Event("input", { bubbles: true })); return document.querySelector('[data-for="maxWars"]')!.textContent; });
console.log({ sliders: n, accentBefore: before.trim(), accentAfter: after, tabs, liveLabel: lab, errors: errs });
if (process.argv[2]) await p.screenshot({ path: process.argv[2], fullPage: true });
// put the look back
await p.evaluate(() => localStorage.removeItem("look"));
await b.close();
