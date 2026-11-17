// Verify the chart hover works in a real browser: npx tsx tools/hovertest.ts
import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1300, height: 900 } });
const errs: string[] = [];
p.on("pageerror", (e) => errs.push(String(e)));
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
await p.goto("http://127.0.0.1:8787");
await p.waitForSelector(".plot svg", { timeout: 15000 });
const box = (await p.locator('.plot[data-chart="vp"]').boundingBox())!;
await p.mouse.move(box.x + box.width * 0.62, box.y + box.height / 2);
await p.waitForTimeout(300);
const tip = await p.locator('.plot[data-chart="vp"] .tip').innerText();
const visible = await p.locator('.plot[data-chart="provinces"] .xh').evaluate((el) => getComputedStyle(el).display);
console.log("tooltip:", JSON.stringify(tip));
console.log("crosshair on the other chart:", visible);
await p.screenshot({ path: "captures/shots/hover.png" });
// the tooltip must survive a live data refresh while hovering
await p.waitForTimeout(4000);
console.log("still shown after refresh:", await p.locator('.plot[data-chart="vp"] .tip').evaluate((el) => getComputedStyle(el).display));
await p.click('[data-range="6h"]');
await p.waitForTimeout(300);
console.log("range 6h pressed:", await p.locator('[data-range="6h"]').getAttribute("aria-pressed"));
console.log("errors:", JSON.stringify(errs));
await b.close();
