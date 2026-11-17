import type { Frame } from "playwright";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("./page/bot.js", import.meta.url), "utf8");

/** Install window.__bot in the game page (idempotent). */
export async function inject(game: Frame): Promise<void> {
  await game.waitForFunction("!!window.hup && !!hup.gameState && !!hup.gameState.getPlayerState()", null, { timeout: 90000 });
  await game.evaluate(SRC);
  await game.waitForFunction("window.__bot && window.__bot.ready()", null, { timeout: 60000 });
}

/** Call window.__bot.<fn>(...args) and return its JSON-serialisable result. */
export async function call<T = any>(game: Frame, fn: string, ...args: unknown[]): Promise<T> {
  return (await game.evaluate(`JSON.stringify(window.__bot.${fn}(...${JSON.stringify(args)}))`).then((s) => JSON.parse(s as string))) as T;
}
