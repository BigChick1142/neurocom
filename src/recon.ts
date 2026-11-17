// Recon tool: opens the game in a real browser with a persistent profile,
// you log in manually (the bot never sees your password), and every
// HTTP response + WebSocket frame is logged to captures/ as JSONL.
import { chromium } from "playwright";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";

const START_URL = process.argv[2] ?? "https://www.conflictofnations.com/";
mkdirSync("captures", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = createWriteStream(`captures/${stamp}.jsonl`);
const log = (o: object) => out.write(JSON.stringify({ t: Date.now(), ...o }) + "\n");

const ctx = await chromium.launchPersistentContext("profile", {
  headless: false,
  viewport: null,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

const MAX_BODY = 200_000;
page.on("response", async (res) => {
  const req = res.request();
  const type = req.resourceType();
  if (!["xhr", "fetch", "document", "script"].includes(type)) return;
  let body: string | undefined;
  if (type === "script" && req.url().includes("/clients/")) {
    try {
      mkdirSync("captures/scripts", { recursive: true });
      const name = new URL(req.url()).pathname.split("/").filter(Boolean).slice(-2).join("_");
      writeFileSync(`captures/scripts/${name}`, await res.body());
    } catch {}
  }
  if (type === "xhr" || type === "fetch") {
    // Game-server state dumps are large and are the most valuable part: keep them whole.
    const isGame = req.url().includes(".c.bytro.com");
    try { const t = await res.text(); body = isGame ? t : t.slice(0, MAX_BODY); } catch {}
  }
  log({
    kind: "http", type, method: req.method(), url: req.url(), status: res.status(),
    reqBody: req.postData()?.slice(0, MAX_BODY), body,
  });
});

page.on("websocket", (ws) => {
  log({ kind: "ws-open", url: ws.url() });
  ws.on("framesent", (f) => log({ kind: "ws-send", url: ws.url(), data: String(f.payload).slice(0, MAX_BODY) }));
  ws.on("framereceived", (f) => log({ kind: "ws-recv", url: ws.url(), data: String(f.payload).slice(0, MAX_BODY) }));
  ws.on("close", () => log({ kind: "ws-close", url: ws.url() }));
});

await page.goto(START_URL);
console.log("Browser open. Log in, join your game, click around (open chat, build a unit, move something).");
console.log("Traffic is being saved to captures/. Close the browser window when done.");
await new Promise<void>((r) => ctx.on("close", () => r()));
out.end();
