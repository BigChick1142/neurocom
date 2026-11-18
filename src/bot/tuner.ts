// Outcome-based tuning: the bot adjusts its own risk knobs from what actually happened.
//  * attackRatio[mode]: lowered after successful conquests, raised after failed attacks.
//  * maxUnits[mode]:    raised when the economy comfortably supports more units, lowered when it is starving.
// Pure functions: the runner records attacks, calls these, applies the patch and logs the notes.
import { R, type GameState, type Mode, type Settings } from "./types.js";

export interface AttackRecord { t: number; target: number; mode: Mode; ids: (string | number)[]; units: number; ratio?: number; human?: boolean }
export type AttackResult = { rec: AttackRecord; result: "success" | "failure" };

const EVAL_AFTER_MS = 20 * 60_000;
const EXPIRE_MS = 120 * 60_000;

/** Decide which recorded attacks have a verdict yet. */
export function evaluateAttacks(s: GameState, recs: AttackRecord[], now = Date.now()): { done: AttackResult[]; keep: AttackRecord[] } {
  const done: AttackResult[] = [];
  const keep: AttackRecord[] = [];
  const owned = new Set(s.provinces.map((p) => p.id));
  for (const rec of recs) {
    if (owned.has(rec.target)) { done.push({ rec, result: "success" }); continue; }
    const age = now - rec.t;
    if (age < EVAL_AFTER_MS) { keep.push(rec); continue; }
    const alive = rec.ids.reduce<number>((n, id) => n + (s.armies.find((a) => String(a.id) === String(id))?.units.length ?? 0), 0);
    if (alive < rec.units * 0.6) { done.push({ rec, result: "failure" }); continue; }
    if (age < EXPIRE_MS) keep.push(rec); // still fighting / marching: no verdict yet
  }
  return { done, keep };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function tuneFromAttacks(st: Settings, results: AttackResult[]): { patch: Partial<Settings>; notes: string[] } {
  const ratio = { ...st.attackRatio };
  const notes: string[] = [];
  for (const { rec, result } of results) {
    const old = ratio[rec.mode];
    ratio[rec.mode] = clamp(result === "success" ? old * 0.95 : old * 1.18, 1.1, 4);
    notes.push(`attack on province ${rec.target} ${result}: ${rec.mode} attackRatio ${old.toFixed(2)} -> ${ratio[rec.mode].toFixed(2)}`);
  }
  return notes.length ? { patch: { attackRatio: ratio }, notes } : { patch: {}, notes };
}

/** Economy-driven unit cap. Called at most once per hour. */
export function tuneUnitCap(s: GameState, st: Settings, mode: Mode): { patch: Partial<Settings>; notes: string[] } {
  const units = s.armies.reduce((a, x) => a + x.units.length, 0);
  const key = [R.SUP, R.MAN, R.MONEY];
  const stock = (id: string) => s.resources[id]?.amount ?? 0;
  const net = (id: string) => s.resources[id]?.perHour ?? 0;
  const cap = st.maxUnits[mode];
  const starving = key.some((id) => net(id) < 0 && stock(id) < (st.reserve[id] ?? 0) * 1.5);
  const comfortable = key.every((id) => net(id) > 0 && stock(id) > (st.reserve[id] ?? 0) * 2.5);
  let next = cap;
  if (starving) next = Math.max(10, cap - 4);
  else if (comfortable && units >= cap - 2) next = Math.min(120, cap + 4);
  if (next === cap) return { patch: {}, notes: [] };
  return { patch: { maxUnits: { ...st.maxUnits, [mode]: next } }, notes: [`${starving ? "economy strained" : "economy has headroom"}: ${mode} maxUnits ${cap} -> ${next}`] };
}
