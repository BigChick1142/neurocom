// Drive the Discord card in a real browser (no secrets typed, nothing saved): npx tsx tools/discord-ui-test.ts
import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 1000 } });
const errs: string[] = [];
p.on("pageerror", (e) => errs.push(String(e)));
p.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
await p.goto("http://127.0.0.1:8787");
await p.waitForSelector('[data-tab="settings"]');
await p.click('[data-tab="settings"]');
await p.waitForSelector("#discord-card");
await p.waitForTimeout(1200);
console.log("card (connected state):", JSON.stringify((await p.locator("#discord-card").innerText()).slice(0, 260)));
await p.locator("#discord-card").screenshot({ path: "captures/shots/discord-connected.png" });
await p.click('[data-dc="change"]');
await p.waitForTimeout(300);
await p.click('[data-dc="check"]'); // empty box: re-checks the saved token on the server
await p.waitForTimeout(2500);
console.log("card (setup flow after Check):", JSON.stringify((await p.locator("#discord-card").innerText()).slice(0, 420)));
console.log("server options:", await p.locator('[data-dc-sel="guild"] option').allInnerTexts());
console.log("channel options:", await p.locator('[data-dc-sel="channel"] option').allInnerTexts());
console.log("owner box value:", await p.locator('[data-dc-in="ownerId"]').inputValue());
await p.locator("#discord-card").screenshot({ path: "captures/shots/discord-setup.png" });
console.log("errors:", JSON.stringify(errs));
await b.close();
