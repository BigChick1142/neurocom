// Player intelligence from the in-game newspaper and player profiles.
// Goal: find WEAK players (inactive, crippled, losing units, unstable) so the planner prefers them as targets,
// and avoid strong ones (big economies, lots of kills). Pure parsing, no I/O.
export interface RawIntel {
  players: Record<string, { id: number; active: boolean; ai: boolean; passive: boolean; defeated: boolean; retired: boolean; rogue?: boolean; morale: number | null; lastLogin: number; team?: number; vps?: number }>;
  news: { day: number; cat: string; title: string; body: string; sid: number; rid: number }[];
}
export interface PlayerIntel {
  id: number; human: boolean; active: boolean; defeated: boolean; morale: number | null;
  inactiveHours: number | null;
  capitalLost: number; unitsLost: number; kills: number; insurgency: number; sneakAttacksSuffered: number; sneakAttacksLaunched: number;
  topEconomyRank: number | null;      // 1..N in "World's Largest Economies", null if not listed
  atWarWith: number[];
  weakness: number;                   // roughly -1 (strong) .. 3 (very weak)
  why: string[];
}

const COUNTRY = /\{\{\{countryLink '[^']*' '(\d+)'\}\}\}/g;
const ids = (s: string) => [...s.matchAll(COUNTRY)].map((m) => Number(m[1]));
// "... ({{{countryLink 'Norway' '63'}}}) (CM 9) has been destroyed by the 6th Elite Infantry Division ({{{countryLink 'Sweden' '18'}}})"
const DESTROYED = /\(\{\{\{countryLink '[^']*' '(\d+)'\}\}\}\)[^({]*?(?:\([^)]*\)\s*)?has been destroyed by[^({]*\(\{\{\{countryLink '[^']*' '(\d+)'\}\}\}\)/g;
const LOST = /\(\{\{\{countryLink '[^']*' '(\d+)'\}\}\}\) lost: (\d+)/g;

/**
 * The client's own "active"/"last login" fields are not populated for other players, so inactivity is OBSERVED:
 * a player whose visible armies (and VP) have not changed for hours is probably not playing.
 * Returns hours of unchanged activity per owner; call every tick.
 */
export function trackActivity(armies: { id: string | number; owner: number; loc: number }[], vps: Record<number, number>, store: Record<string, { sig: string; since: number }>, now = Date.now()): Record<number, number> {
  const byOwner = new Map<number, string[]>();
  for (const a of armies) { const l = byOwner.get(a.owner) ?? []; l.push(`${a.id}@${a.loc}`); byOwner.set(a.owner, l); }
  const hours: Record<number, number> = {};
  for (const [owner, list] of byOwner) {
    const sig = list.sort().join(",") + "|" + (vps[owner] ?? 0);
    const cur = store[String(owner)];
    if (!cur || cur.sig !== sig) store[String(owner)] = { sig, since: now };
    hours[owner] = (now - store[String(owner)].since) / 3_600_000;
  }
  return hours;
}

export function buildIntel(raw: RawIntel, now = Date.now(), observedIdleHours: Record<number, number> = {}): Record<number, PlayerIntel> {
  const out: Record<number, PlayerIntel> = {};
  const get = (id: number): PlayerIntel => (out[id] ??= {
    id, human: false, active: true, defeated: false, morale: null, inactiveHours: null,
    capitalLost: 0, unitsLost: 0, kills: 0, insurgency: 0, sneakAttacksSuffered: 0, sneakAttacksLaunched: 0, topEconomyRank: null, atWarWith: [], weakness: 0, why: [],
  });

  for (const p of Object.values(raw.players)) {
    const i = get(p.id);
    i.human = !p.ai; i.defeated = p.defeated || p.retired; i.morale = p.morale;
    const idle = observedIdleHours[p.id];
    if (!p.ai && idle !== undefined) { i.inactiveHours = idle; i.active = idle < 6; }
  }

  const rogue = new Set(Object.values(raw.players).filter((p) => p.rogue).map((p) => p.id)); // insurgents are not an opponent to learn from
  // Newspaper is re-read every few minutes and articles repeat, so de-duplicate by content.
  const seen = new Set<string>();
  for (const a of raw.news) {
    const key = a.cat + "|" + a.title + "|" + a.body.slice(0, 120);
    if (seen.has(key)) continue; seen.add(key);

    if (a.cat === "capital_captured") {
      const t = ids(a.title); if (t.length >= 2) { get(t[1]).capitalLost++; get(t[0]).kills++; }
    } else if (a.cat === "insurgency") {
      const t = ids(a.title); if (t.length) get(t[0]).insurgency++;
    } else if (a.cat === "sneakattack") {
      if (a.sid > 0) get(a.sid).sneakAttacksSuffered++;
      if (a.rid > 0) get(a.rid).sneakAttacksLaunched++;
      if (a.sid > 0 && a.rid > 0) { get(a.sid).atWarWith.push(a.rid); get(a.rid).atWarWith.push(a.sid); }
    } else if (a.cat === "casualties") {
      const t = [...new Set(ids(a.title))]; if (t.length === 2) { get(t[0]).atWarWith.push(t[1]); get(t[1]).atWarWith.push(t[0]); }
    } else if (a.cat === "statistics" && /Largest Economies/i.test(a.title)) {
      ids(a.body).forEach((id, idx) => { get(id).topEconomyRank = idx + 1; });
    }
    // combat reports: who destroyed whose units
    if (/destroyed|captured|annihilated|occup/i.test(a.cat + a.title)) {
      for (const m of a.body.matchAll(DESTROYED)) { const v = Number(m[1]), k = Number(m[2]); if (v !== k && !rogue.has(v) && !rogue.has(k)) { get(v).unitsLost++; get(k).kills++; } }
    }
    if (a.cat === "unit_destroyed" || a.cat === "airplanedestroyed") {
      for (const m of a.body.matchAll(LOST)) get(Number(m[1])).unitsLost += Number(m[2]);
    }
  }

  for (const i of Object.values(out)) {
    i.atWarWith = [...new Set(i.atWarWith)];
    const w: [number, string][] = [];
    if (i.human && i.inactiveHours !== null && i.inactiveHours >= 6) w.push([Math.min(1.5, 0.4 + i.inactiveHours / 20), `no visible activity for ${i.inactiveHours.toFixed(0)}h`]);
    if (i.capitalLost > 0) w.push([1.0, "capital occupied"]);
    if (i.insurgency > 0) w.push([Math.min(0.75, 0.25 * i.insurgency), "insurgency"]);
    if (i.unitsLost + i.kills >= 3) w.push([0.8 * (i.unitsLost / (i.unitsLost + i.kills + 3)) - 0.4 * (i.kills / (i.unitsLost + i.kills + 3)), "losing/winning fights"]);
    if (i.morale !== null && i.morale < 0.6) w.push([0.5, "low morale"]);
    if (i.atWarWith.length >= 2) w.push([0.3, "fighting " + i.atWarWith.length + " wars"]);
    if (i.topEconomyRank !== null && i.topEconomyRank <= 10) w.push([-0.5, "top-10 economy"]);
    if (i.defeated) w.push([-5, "already defeated"]);
    i.weakness = w.reduce((a, [x]) => a + x, 0);
    i.why = w.filter(([x]) => x !== 0).map(([x, t]) => `${t} (${x > 0 ? "+" : ""}${x.toFixed(2)})`);
  }
  return out;
}

/** Multiplier applied to a target's value: weak owners are worth more effort, strong ones less. */
export const weaknessMultiplier = (i: PlayerIntel | undefined) => (i ? Math.min(2.2, Math.max(0.5, 1 + 0.5 * i.weakness)) : 1);

// ------------------------------------------------------------------ learning from fights
import type { EnemyRecord, GameState } from "./types.js";

/** Biggest ground stack seen per owner near my land. Decays slowly (half-life ~11h at one call per 20s) so old scares fade. */
export function updateEnemyRecords(s: GameState, enemy: Record<string, EnemyRecord>, now = Date.now()): void {
  for (const r of Object.values(enemy)) r.stack *= 0.9994;
  for (const a of s.otherArmies) {
    if (a.removed || a.owner === s.me.id || a.owner === 0 || a.air || a.sea) continue;
    if (!s.provinces.some((p) => Math.hypot(a.x - p.x, a.y - p.y) < 250)) continue;
    const r = (enemy[String(a.owner)] ??= { stack: 0, seen: 0, lossesTo: 0, lastLoss: 0 });
    if (a.str > r.stack) r.stack = a.str;
    r.seen = now;
  }
}

/**
 * Called when a province of mine changes hands. Records it and writes a lesson that is specific to THIS loss
 * (was anything defending it, how big was the stack that took it, how far away was my nearest army), not a generic paragraph.
 */
export function lossLesson(s: GameState, enemy: Record<string, EnemyRecord>, provinceName: string, owner: number | undefined, now = Date.now(), ctx?: { prev?: GameState | null; x?: number; y?: number }): string {
  const pl = s.players.find((p) => p.id === owner);
  if (!owner || owner === 0 || !pl) return `Lost ${provinceName}.`;
  const r = (enemy[String(owner)] ??= { stack: 0, seen: 0, lossesTo: 0, lastLoss: 0 });
  r.lossesTo++; r.lastLoss = now;
  const head = `Lost ${provinceName} to ${pl.nation} (time #${r.lossesTo}).`;
  const prev = ctx?.prev, x = ctx?.x, y = ctx?.y;
  if (!prev || x === undefined || y === undefined) return `${head} Lesson: no detail was available for this one.`;
  const near = (a: { x: number; y: number }) => Math.hypot(a.x - x, a.y - y);
  const ground = prev.armies.filter((a) => !a.air && !a.sea);
  const defence = ground.filter((a) => near(a) < 60).reduce((v, a) => v + a.def, 0);
  const closest = ground.length ? Math.min(...ground.map(near)) : Infinity;
  const stack = Math.max(0, ...prev.otherArmies.filter((a) => a.owner === owner && !a.air && !a.sea && near(a) < 150).map((a) => a.str));
  if (defence < 1) return `${head} Nothing was defending it${Number.isFinite(closest) ? ` (my nearest army was ${Math.round(closest)} units away)` : ""}. Lesson: an undefended border province falls to any raid, so keep an army within reach of the ones I want to keep.`;
  if (stack > 0 && defence < stack * 0.8) return `${head} My ${defence.toFixed(0)} defence there faced their ${stack.toFixed(0)}. Lesson: against ${pl.nation} I need about ${Math.ceil(stack * 1.2)} strength in one place, otherwise it is better to pull back.`;
  return `${head} ${defence.toFixed(0)} defence was there${stack ? ` against ${stack.toFixed(0)}` : ""} and it still fell. Lesson: they brought more than I could see, so I should expect heavier stacks than the visible ones.`;
}

/** Defence estimate for a province of this owner learned from experience (0 = nothing learned). */
export function learnedDefence(enemy: Record<string, EnemyRecord> | undefined, owner: number): number {
  const r = enemy?.[String(owner)];
  return r ? r.stack * (0.5 + 0.15 * Math.min(r.lossesTo, 3)) : 0;
}
