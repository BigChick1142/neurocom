// The game's static rules (unit stats, building times, research names) live in data/*.json.
// They are read FROM THE GAME ITSELF on first run (see dumpRules in src/dumpmod.ts) and are never shipped with this project.
// Loading is lazy and can be refreshed, so the files may appear after the bot has already started.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let DIR = process.env.CON_DATA_DIR ?? "data";
export const setRulesDir = (dir: string) => { DIR = dir; reloadRules(); };
export const rulesDir = () => DIR;

/** Files the planners can use. Without them the bot still plays, just with coarser estimates. */
export const RULE_FILES = ["upgrades", "unitTypes", "researchTypes"] as const;
export const rulesPresent = (dir = DIR) => RULE_FILES.every((f) => existsSync(join(dir, f + ".json")));

interface Cache { upgradeHours?: Record<string, number>; unitCost?: Record<string, number>; unitRange?: Record<string, number>; researchName?: Record<string, string> }
let cache: Cache = {};
export const reloadRules = () => { cache = {}; };

const readJson = (name: string): Record<string, any> | null => {
  try { const f = join(DIR, name + ".json"); return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null; } catch { return null; }
};

/** Hours a construction takes (default 24h when unknown). */
export function upgradeHours(id: number): number {
  if (!cache.upgradeHours) {
    const m: Record<string, number> = {};
    const u = readJson("upgrades");
    if (u) for (const [k, v] of Object.entries<any>(u)) m[k] = (v.buildTime ?? 0) / 3600;
    cache.upgradeHours = m;
  }
  return cache.upgradeHours[String(id)] ?? 24;
}

function unitTables() {
  if (!cache.unitCost || !cache.unitRange) {
    const cost: Record<string, number> = {}, range: Record<string, number> = {};
    const u = readJson("unitTypes");
    if (u) for (const r of Object.values<any>(u)) {
      const c = Object.values<number>(r.costs ?? {}).reduce((a, b) => a + b, 0);
      const rg = Object.values<number>(r.ranges ?? {})[0];
      for (const n of [r.typeName, r.unitName]) {
        if (!n) continue;
        if (c && !(n in cost)) cost[n] = c;
        if (rg && !(n in range)) range[n] = rg;
      }
    }
    cache.unitCost = cost; cache.unitRange = range;
  }
  return { cost: cache.unitCost!, range: cache.unitRange! };
}
/** Total resource cost of a unit type (3000 when unknown). */
export const unitCost = (name: string | undefined) => unitTables().cost[name ?? ""] ?? 3000;
/** Weapon / flight range in km for a unit type name (conservative 150 when unknown). */
export const unitRangeKm = (name: string | undefined) => unitTables().range[name ?? ""] ?? 150;

export function researchName(id: number): string {
  if (!cache.researchName) {
    const m: Record<string, string> = {};
    const r = readJson("researchTypes");
    if (r) for (const [k, v] of Object.entries<any>(r)) m[k] = v.name ?? k;
    cache.researchName = m;
  }
  return cache.researchName[String(id)] ?? "#" + id;
}
