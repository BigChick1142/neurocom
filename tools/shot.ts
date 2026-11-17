// Screenshot the local dashboard (all tabs, desktop + phone) and report console errors: npx tsx tools/shot.ts
import { chromium } from "playwright";
const b = await chromium.launch();
const errs: string[] = [];
for (const [name, vp] of [["desktop", { width: 1300, height: 900 }], ["phone", { width: 390, height: 800 }]] as const) {
  const p = await b.newPage({ viewport: vp });
  p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto("http://127.0.0.1:8787");
  await p.waitForTimeout(2500);
  for (const t of ["home", "military", "economy", "diplomacy", "stats", "activity", "settings"]) {
    await p.click(`[data-tab=${t}]`);
    await p.waitForTimeout(300);
    await p.screenshot({ path: `captures/shots/${name}-${t}.png`, fullPage: name === "desktop" });
  }
  await p.close();
}
console.log("errors:", JSON.stringify(errs));
await b.close();
