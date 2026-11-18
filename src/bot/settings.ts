import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Settings } from "./types.js";


export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  dryRun: false,
  mode: "balanced",
  autoMode: true,
  tickSeconds: 20,
  doResearch: true, doBuild: true, doMobilize: true, doMilitary: true, doDiplomacy: true, doMessaging: true, doMarket: true, doCoalition: true,
  warPolicy: "non_allies", // coalition/allies are always protected; attacks still gated by strength ratio & mode
  allowWmd: false,
  // keep a cushion so upkeep never starves us
  reserve: { "1": 800, "2": 500, "3": 150, "4": 300, "5": 400, "6": 300, "20": 3000 },
  maxUnits: { economy: 14, balanced: 36, aggressive: 80 },
  attackRatio: { economy: 3.0, balanced: 1.8, aggressive: 1.25 },
  protectedPlayers: [],
  targetPlayers: [],
  campaign: { first: "", peaceWith: [], then: [], cities: true },
  useKnowledge: true,
  maxWars: 2, econCushion: 0.4, doAnnex: true, doLab: true,
  messageLimitPerHour: 6,
  // stock: floors we always try to hold (scarce inputs only). Everything else is bought only when a wanted build/research/unit is blocked by it.
  market: { stock: { "4": 600, "5": 500 }, maxSpendPct: 0.5, maxPriceMult: 1.3, staleHours: 3, sell: true, keep: { "1": 1500, "2": 1500, "4": 800, "5": 1000, "6": 800 }, sellWhenMoneyBelow: 4 },
  weights: {
    "Arms Industry": 100, "Local Industry": 80, "Population level": 55, "Army Base": 70, "Recruiting Office": 45,
    "Military Hospital": 25, "Air Base": 12, "Naval Base": 6, "Combat Outpost": 28, "Field Hospital": 10, "Underground Bunkers": 8,
  },
};

export function loadSettings(dir = "data"): Settings {
  const FILE = `${dir}/settings.json`;
  try {
    if (existsSync(FILE)) {
      const saved = JSON.parse(readFileSync(FILE, "utf8"));
      return { ...DEFAULT_SETTINGS, ...saved, market: { ...DEFAULT_SETTINGS.market, ...(saved.market ?? {}) } };
    }
  } catch { /* fall through */ }
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(s: Settings, dir = "data"): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/settings.json`, JSON.stringify(s, null, 2));
}

/** Merge a partial patch from the dashboard, keeping only known keys with sane types. */
export function patchSettings(cur: Settings, patch: Record<string, unknown>): Settings {
  const next: any = structuredClone(cur);
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const d: any = (DEFAULT_SETTINGS as any)[k];
    if (typeof d === "boolean" && typeof v === "boolean") next[k] = v;
    else if (typeof d === "number" && typeof v === "number" && Number.isFinite(v)) next[k] = v;
    else if (typeof d === "string" && typeof v === "string") next[k] = v;
    else if (Array.isArray(d) && Array.isArray(v)) next[k] = v.map(Number).filter(Number.isFinite);
    else if (d && typeof d === "object" && !Array.isArray(d) && v && typeof v === "object") next[k] = { ...d, ...(next[k] ?? {}), ...(v as object) };
  }
  if (!["economy", "balanced", "aggressive"].includes(next.mode)) next.mode = cur.mode;
  if (!["none", "ai_only", "non_allies"].includes(next.warPolicy)) next.warPolicy = cur.warPolicy;
  next.tickSeconds = Math.min(300, Math.max(5, next.tickSeconds));
  next.maxWars = Math.round(Math.min(8, Math.max(1, next.maxWars)));
  next.econCushion = Math.min(1, Math.max(0, next.econCushion));
  return next as Settings;
}
