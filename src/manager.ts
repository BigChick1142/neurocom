// Runs one player (Bot) per open game tab. Open a game in the bot's browser window and a player starts for it;
// close the tab (or leave the game) and that player stops. Each game has its own settings, memory and history.
import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright";
import { PLAY_URL, isGameFrame, openContext, sessionFor } from "./browser.js";
import { Bot } from "./bot/runner.js";
import { gameDir, gameIdFromUrl, migrateLegacy } from "./bot/games.js";

export interface GameInfo { id: string; nation: string; name: string; day: number; vp: number; connected: boolean; enabled: boolean }

export class GameManager extends EventEmitter {
  bots = new Map<string, Bot>();
  private byPage = new Map<Page, string>();
  private ctx: BrowserContext | null = null;
  private closeBrowser: (() => Promise<void>) | null = null;
  private timer: NodeJS.Timeout | null = null;

  get(id: string | null | undefined): Bot | undefined { return id ? this.bots.get(id) : undefined; }

  /** A PNG of the game's own browser tab (the map as the game shows it). Null when that tab is not open. */
  async gameShot(id: string): Promise<Buffer | null> {
    for (const [page, gid] of this.byPage) {
      if (gid !== id || page.isClosed()) continue;
      return await page.screenshot({ type: "png", timeout: 20_000 });
    }
    return null;
  }
  first(): Bot | undefined { return this.bots.values().next().value; }

  list(): GameInfo[] {
    return [...this.bots.values()].map((b) => ({
      id: b.gameId, nation: b.state?.me.nation ?? "?", name: b.state?.me.name ?? "", day: b.state?.day ?? 0, vp: b.state?.me.vps ?? 0,
      connected: b.connected, enabled: b.settings.enabled,
    }));
  }

  /** Resolve "12345678", a unique id prefix, or a nation / player name (case-insensitive). */
  find(q: string | null | undefined): Bot | undefined {
    if (!q) return undefined;
    const s = q.trim().toLowerCase();
    const hits = [...this.bots.values()].filter((b) => b.gameId === s || b.gameId.startsWith(s) || b.state?.me.nation.toLowerCase() === s || b.state?.me.name.toLowerCase() === s);
    return hits.length === 1 ? hits[0] : undefined;
  }

  async start() {
    const { ctx, close } = await openContext();
    this.ctx = ctx; this.closeBrowser = close;
    // Make sure there is a tab on the game site so the user can pick a game (or the last one reopens by itself).
    if (!ctx.pages().length) { const p = await ctx.newPage(); await p.goto(PLAY_URL, { waitUntil: "domcontentloaded" }); }
    else if (!ctx.pages().some((p) => p.url().includes("play.php"))) { await ctx.pages()[0].goto(PLAY_URL, { waitUntil: "domcontentloaded" }); }
    await this.scan();
    this.timer = setInterval(() => { this.scan().catch((e) => console.error("scan failed:", (e as Error).message)); }, 15_000);
    console.log("Game manager running: open a game in the browser window and a player starts for it.");
  }

  /** Open an extra tab on the game site, so another game can be picked there. */
  async openTab(): Promise<void> {
    if (!this.ctx) throw new Error("browser not ready");
    const p = await this.ctx.newPage();
    await p.goto(PLAY_URL, { waitUntil: "domcontentloaded" });
  }

  private async scan() {
    if (!this.ctx) return;
    const pages = this.ctx.pages();
    // forget closed tabs
    for (const [page, id] of [...this.byPage]) {
      if (page.isClosed() || !pages.includes(page)) this.detach(page, id, "tab closed");
    }
    for (const page of pages) {
      const frame = page.frames().find(isGameFrame);
      const id = frame ? gameIdFromUrl(frame.url()) : null;
      const cur = this.byPage.get(page);
      if (cur && cur !== id) this.detach(page, cur, id ? "tab moved to another game" : "tab left the game");
      if (!id || this.byPage.has(page)) continue;
      if (this.bots.has(id)) continue; // the same game open in two tabs: the first one plays it
      const dir = gameDir(id);
      migrateLegacy(dir);
      const bot = new Bot({ gameId: id, dataDir: dir });
      this.bots.set(id, bot); this.byPage.set(page, id);
      this.emit("bot-added", bot);
      bot.start(sessionFor(page)).catch((e) => { bot.log("error", "boot", `Player stopped: ${(e as Error).message}`); this.detach(page, id, "crashed"); });
    }
  }

  private detach(page: Page, id: string, why: string) {
    const bot = this.bots.get(id);
    if (bot) { bot.log("info", "boot", `Stopped playing game ${id}: ${why}`); bot.stop(); }
    this.bots.delete(id); this.byPage.delete(page);
    this.emit("bot-removed", id);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const b of this.bots.values()) b.stop();
  }
}
