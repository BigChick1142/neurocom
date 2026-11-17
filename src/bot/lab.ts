// Learning layer for unit classes (land / air / sea).
// The game never tells me "air is worth it", so I measure: per class, capital tied up (unit cost x hours alive),
// kills scored and units lost. The ratio against land (my baseline) scales how much of the force, research and
// base-building goes into that class. Shrinkage toward 1.0 keeps small samples from swinging the mix.
import { existsSync, readFileSync } from "node:fs";
import type { GameState, LabMemory, UnitClass } from "./types.js";

import { unitCost } from "./rules.js";
export { unitCost };

const MAX_DT_H = 0.5; // a long gap (restart, sleep) must not credit hours that were not observed

/** Call once per tick with the fresh state. Mutates the ledger. */
export function trackLab(s: GameState, lab: LabMemory, now = Date.now()): void {
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
      if (prev && u.k > prev.k) lab.classes[cls].kills += u.k - prev.k;
      lab.seen[key] = { cls, k: u.k ?? 0, cost, t: now };
    }
  }
  // Units I had and no longer have (and that were seen recently) are losses. Old/stale entries are just garbage-collected.
  if (!s.armies.length) return; // a blank read (page reloading) must not look like an annihilation
  for (const [key, v] of Object.entries(lab.seen)) {
    if (present.has(key)) continue;
    if (now - v.t < 3 * 60_000 * 20) lab.classes[v.cls].lost++; // seen within the last ~hour of ticks
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
