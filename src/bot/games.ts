// Per-game storage. Every game the bot plays gets its own folder (settings, memory, history, activity log),
// so games never share state and a new game always starts from neutral defaults.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const GAMES_DIR = "data/games";
export const gameDir = (gameId: string) => join(GAMES_DIR, gameId);

/** The game id is part of the game client's URL: .../index.html?...&gameID=12345678&... */
export const gameIdFromUrl = (url: string): string | null => /[?&]gameID=(\d+)/.exec(url)?.[1] ?? null;

const LEGACY_FILES = ["settings.json", "memory.json", "history.jsonl", "activity.jsonl"];

/**
 * One-time upgrade from the single-game layout: when the first game is attached and nothing exists under data/games yet,
 * the old data/*.json files are COPIED (never moved) into that game's folder so its learned state carries over.
 */
export function migrateLegacy(dir: string, dataRoot = "data"): boolean {
  const gamesRoot = join(dataRoot, "games");
  if (existsSync(gamesRoot) && readdirSync(gamesRoot).length > 0) { mkdirSync(dir, { recursive: true }); return false; }
  mkdirSync(dir, { recursive: true });
  let copied = false;
  for (const f of LEGACY_FILES) {
    const from = join(dataRoot, f);
    if (existsSync(from) && !existsSync(join(dir, f))) { copyFileSync(from, join(dir, f)); copied = true; }
  }
  return copied;
}

/** For command-line tools: the most recently active game folder, or the old data/ folder if there is none. */
export function defaultGameDir(dataRoot = "data"): string {
  const gamesRoot = join(dataRoot, "games");
  try {
    const dirs = readdirSync(gamesRoot).map((d) => join(gamesRoot, d)).filter((d) => statSync(d).isDirectory());
    const stamp = (d: string) => { try { return statSync(join(d, "history.jsonl")).mtimeMs; } catch { return 0; } };
    dirs.sort((a, b) => stamp(b) - stamp(a));
    if (dirs.length) return dirs[0];
  } catch { /* no games folder yet */ }
  return dataRoot;
}
