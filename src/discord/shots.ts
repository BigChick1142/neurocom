// Screenshots for Discord: the dashboard (any tab) and the game map. One at a time, so a few quick taps never pile up browsers.
// The dashboard is photographed in its own throw-away headless browser: it never touches the game window or its saved view.
import { chromium } from "playwright";

export const DASH_TABS = [["home", "Home"], ["military", "Military"], ["economy", "Economy"], ["diplomacy", "Diplomacy"], ["players", "Players"], ["stats", "Stats"], ["brain", "Brain"]] as const;

let chain: Promise<unknown> = Promise.resolve();
/** Run screenshot jobs strictly one after another. */
export function inQueue<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.then(job, job);
  chain = run.catch(() => undefined);
  return run;
}

/** A PNG of one dashboard tab for one game. */
export function dashboardShot(port: number, gameId: string, tab: string): Promise<Buffer> {
  return inQueue(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
      await page.addInitScript(([g, t]) => { try { localStorage.setItem("game", g); localStorage.setItem("tab", t); localStorage.setItem("theme", "dark"); } catch { /* storage blocked */ } }, [gameId, tab]);
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded", timeout: 20_000 });
      await page.waitForSelector("#main .card, #main .kpis, #main .stack", { timeout: 15_000 });
      await page.waitForTimeout(tab === "stats" || tab === "brain" ? 2500 : 1200); // these two load their numbers after the page
      return await page.screenshot({ type: "png", fullPage: true });
    } finally { await browser.close().catch(() => undefined); }
  });
}
