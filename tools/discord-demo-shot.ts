// Screenshot the Discord card filled with SAMPLE data (no real account details): npx tsx tools/discord-demo-shot.ts
import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
await p.goto("http://127.0.0.1:8787");
await p.click('[data-tab="settings"]'); await p.waitForSelector("#discord-card"); await p.waitForTimeout(1200);
await p.evaluate(() => {
  // @ts-ignore: page globals
  DC.status = { configured: false, connected: false, saved: { hasToken: false, guildId: "", channelId: "", ownerId: "" } };
  // @ts-ignore
  DC.info = { ok: true, botName: "Neurocom#1234", appId: "100000000000000001", inviteUrl: "https://discord.com", guilds: [{ id: "1", name: "My Server" }], owner: { id: "123456789012345678", name: "you" } };
  // @ts-ignore
  DC.guildId = "1"; DC.channels = [{ id: "2", name: "neurocom-alerts" }, { id: "3", name: "general" }]; DC.channelId = "2"; DC.ownerId = "123456789012345678"; DC.token = "";
  // @ts-ignore
  dcRender();
});
await p.locator("#discord-card").screenshot({ path: "docs/img/dashboard-discord.png" });
await b.close();
console.log("sample screenshot saved");
