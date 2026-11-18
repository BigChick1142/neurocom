// Learning layer for unit classes (land / air / sea).
// The game never tells me "air is worth it", so I measure: per class, capital tied up (unit cost x hours alive),
// kills scored and units lost. The ratio against land (my baseline) scales how much of the force, research and
// base-building goes into that class. Shrinkage toward 1.0 keeps small samples from swinging the mix.
import { existsSync, readFileSync } from "node:fs";
import type { GameState, LabMemory, UnitClass, UnitStat } from "./types.js";

import { unitCost } from "./rules.js";
export { unitCost };

const MAX_DT_H = 0.5; // a long gap (restart, sleep) must not credit hours that were not observed

/** Call once per tick with the fresh state. Mutates the ledger. */
export type UnitEvent = (kind: "fielded" | "kill" | "lost" | "hours", name: string, amount: number, cost: number) => void;
export function trackLab(s: GameState, lab: LabMemory, now = Date.now(), sink?: UnitEvent): void {
  const by = (lab.byType ??= {});
  const stat = (name: string, cls: UnitClass, cost: number): UnitStat => (by[name] ??= { fielded: 0, kills: 0, lost: 0, hours: 0, cost, cls });
  const dt = lab.lastT ? Math.min(MAX_DT_H, Math.max(0, (now - lab.lastT) / 3_600_000)) : 0;
  lab.lastT = now;
  const present = new Set<string>();
  for (const a of s.armies) {
    const cls: UnitClass = a.air ? "air" : a.sea ? "sea" : "land";
    for (const u of a.units) {
      if (u.n && !lab.discovered.includes(u.n)) lab.discovered.push(u.n);
      if (u.id === undefined) continue;
      const key = String(u.id);
      present.add(key);
      const cost = unitCost(u.n);
      const prev = lab.seen[key];
      lab.classes[cls].capitalHours += cost * dt;
      const nm = u.n ?? "Unknown unit", st = stat(nm, cls, cost);
      st.hours += dt; if (dt > 0) sink?.("hours", nm, dt, cost);
      if (!prev || !prev.n) { st.fielded++; sink?.("fielded", nm, 1, cost); } // first time seen (or seen before names were tracked)
      if (prev && u.k > prev.k) { lab.classes[cls].kills += u.k - prev.k; st.kills += u.k - prev.k; sink?.("kill", nm, u.k - prev.k, cost); }
      lab.seen[key] = { cls, k: u.k ?? 0, cost, t: now, n: nm };
    }
  }
  // Units already alive when tracking began (or counted before names were tracked) still count as fielded: never fewer than alive + lost.
  const alive: Record<string, number> = {};
  for (const a of s.armies) for (const u of a.units) if (u.id !== undefined) alive[u.n ?? "Unknown unit"] = (alive[u.n ?? "Unknown unit"] ?? 0) + 1;
  for (const [nm, c] of Object.entries(alive)) { const st = by[nm]; if (st && st.fielded < c + st.lost) { sink?.("fielded", nm, c + st.lost - st.fielded, st.cost); st.fielded = c + st.lost; } }
  // Units I had and no longer have (and that were seen recently) are losses. Old/stale entries are just garbage-collected.
  if (!s.armies.length) return; // a blank read (page reloading) must not look like an annihilation
  for (const [key, v] of Object.entries(lab.seen)) {
    if (present.has(key)) continue;
    if (now - v.t < 3 * 60_000 * 20) { // seen within the last ~hour of ticks
      lab.classes[v.cls].lost++;
      if (v.n) { stat(v.n, v.cls, v.cost).lost++; sink?.("lost", v.n, 1, v.cost); }
    }
    delete lab.seen[key];
  }
}

/** Return on capital relative to land. >1 means this class earns more than land per unit of capital. */
export function classScore(lab: LabMemory, cls: UnitClass): number {
  const c = lab.classes[cls];
  const cap = c.capitalHours / 1e5; // 100k capital-hours ~ one 4000-cost unit alive for 25h
  return (c.kills - 0.8 * c.lost + 1) / (cap + 1);
}

export interface LabPlan {
  /** shares of the *whole* force the planner should aim for */
  airShare: number; seaShare: number;
  /** learned multipliers (1 = no evidence yet) */
  mAir: number; mSea: number;
  /** evidence strength per class: capital-hours / 1e5 */
  evidence: { air: number; sea: number; land: number };
}

const SHARE = { air: 0.1, sea: 0.05 };
const PRIOR_WEIGHT = 1.0; // pseudo-observations at multiplier 1.0

export function labPlan(lab: LabMemory, opts: { mode: "economy" | "balanced" | "aggressive"; noLandTargets: boolean; coastalFrontier: boolean }): LabPlan {
  const land = classScore(lab, "land");
  const mult = (cls: "air" | "sea") => {
    const n = lab.classes[cls].capitalHours / 1e5; // evidence
    const raw = land > 0 ? classScore(lab, cls) / land : 1;
    const m = (n * raw + PRIOR_WEIGHT * 1) / (n + PRIOR_WEIGHT);
    return Math.min(3, Math.max(0.2, m));
  };
  const mAir = mult("air"), mSea = mult("sea");
  const econ = opts.mode === "economy";
  const airShare = econ ? 0 : SHARE.air * mAir;
  const seaShare = econ ? 0 : (opts.noLandTargets ? 0.25 : opts.coastalFrontier ? SHARE.sea : SHARE.sea * 0.4) * mSea;
  return { airShare, seaShare, mAir, mSea, evidence: { air: lab.classes.air.capitalHours / 1e5, sea: lab.classes.sea.capitalHours / 1e5, land: lab.classes.land.capitalHours / 1e5 } };
}

/** Plain numbers for the dashboard: overall kill/death record, attack results, and every unit type ranked by how much it has helped. */
export function combatSummary(lab: LabMemory) {
  const kills = Object.values(lab.classes).reduce((a, c) => a + c.kills, 0), lost = Object.values(lab.classes).reduce((a, c) => a + c.lost, 0);
  const att = lab.attacks ?? { won: 0, failed: 0 };
  const units = Object.entries(lab.byType ?? {}).map(([name, u]) => ({
    name, cls: u.cls, fielded: u.fielded, kills: u.kills, lost: u.lost, hours: u.hours, cost: u.cost,
    kd: u.kills / Math.max(1, u.lost), avgLife: u.fielded ? u.hours / u.fielded : 0,
    // helpfulness: kills earned (and units kept alive) per 1000 of value-hours, smoothed so one lucky kill does not top the list
    score: (u.kills + 1) / (0.8 * u.lost + 1) / (1 + (u.cost * u.hours) / 1e5),
  })).sort((a, b) => b.score - a.score);
  return {
    kills, lost, kd: kills / Math.max(1, lost), attacks: att, attackRate: att.won + att.failed ? att.won / (att.won + att.failed) : null,
    classes: (["land", "air", "sea"] as UnitClass[]).map((c) => ({ cls: c, kills: lab.classes[c].kills, lost: lab.classes[c].lost, capital: lab.classes[c].capitalHours })),
    units,
  };
}
