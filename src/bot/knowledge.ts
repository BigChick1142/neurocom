// Shared knowledge base: what Neurocom has learned across EVERY game it has played on this PC.
// Per-game memory (memory.json) is about one game; this file (data/knowledge.json) is about the game in general:
// how big a strength margin wins fights against computer vs human players, which messages get answered, how often
// peace offers and coalition applications succeed, what things normally cost on the market, how fast a game normally
// grows by day. New games start from it, and the planners consult it. Pure data + math here (no game access).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type TargetKind = "ai" | "human";
interface WL { w: number; l: number }
interface Pair { offered: number; ok: number }

/** Strength-ratio buckets for attacks: lower edge of each. */
const EDGES = [0, 1.0, 1.2, 1.5, 2.0, 3.0];
const bucketOf = (ratio: number) => { let b = 0; for (let i = 0; i < EDGES.length; i++) if (ratio >= EDGES[i]) b = i; return b; };
export const bucketLabel = (b: number) => (b === 0 ? "<1" : b === EDGES.length - 1 ? `${EDGES[b]}+` : `${EDGES[b]}-${EDGES[b + 1]}`);
const sizeBucket = (members: number) => (members <= 1 ? "1" : members <= 3 ? "2-3" : "4+");
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const ewma = (old: number | undefined, x: number, alpha: number, n: number) => (old === undefined || n <= 0 ? x : old + (x - old) * alpha);
const MAX_TEXTS = 400;

export interface KBData {
  v: 1;
  updated: number;
  games: string[];                                  // ids of games seen (so a game is counted once)
  battles: Record<TargetKind, WL[]>;                // per strength-ratio bucket: attacks that took the province vs failed
  peace: Record<TargetKind, Pair>;                  // peace offers sent / accepted
  coalition: Record<string, { applied: number; joined: number; refused: number; hours: number }>; // by coalition size bucket
  texts: Record<string, { sent: number; replied: number }>; // message wording -> times sent / answered
  prices: Record<string, { fair: number; n: number; t?: number }>; // resource id -> slow average of what it really costs (one sample per 10 minutes)
  pace: Record<string, { vp: number; provinces: number; units: number; money: number; n: number }>; // game day -> typical values
  defence: { undefended: number; defended: number };        // provinces lost with nobody defending vs lost anyway
  params: { attackRatio?: Record<string, number>; maxUnits?: Record<string, number>; n: number }; // settled risk knobs of past games
  lessons: { key: string; text: string; n: number; last: number }[];
  units: Record<string, { fielded: number; kills: number; lost: number; hours: number; cost: number }>; // unit type -> results across every game
}

const fresh = (): KBData => ({
  v: 1, updated: 0, games: [], battles: { ai: EDGES.map(() => ({ w: 0, l: 0 })), human: EDGES.map(() => ({ w: 0, l: 0 })) },
  peace: { ai: { offered: 0, ok: 0 }, human: { offered: 0, ok: 0 } }, coalition: {}, texts: {}, prices: {}, pace: {},
  defence: { undefended: 0, defended: 0 }, params: { n: 0 }, lessons: [], units: {},
});

export class Knowledge {
  data: KBData = fresh();
  private file: string | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Load from (and from now on save to) a file. Safe to call once at start-up. */
  attach(file: string): void {
    this.file = file;
    try {
      if (existsSync(file)) {
        const d = JSON.parse(readFileSync(file, "utf8")) as KBData;
        if (d && d.v === 1) { const f = fresh(); this.data = { ...f, ...d, battles: { ...f.battles, ...d.battles }, peace: { ...f.peace, ...d.peace } }; }
      }
    } catch { /* unreadable: start fresh, the old file is left alone until the next save overwrites it */ }
  }
  /** Forget everything learned so far. */
  reset(): void { this.data = fresh(); this.touch(); }

  private touch() {
    this.data.updated = Date.now(); this.dirty = true;
    if (this.file && !this.timer) this.timer = setTimeout(() => { this.timer = null; this.save(); }, 15_000);
  }
  save(): void {
    if (!this.file || !this.dirty) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.data)); renameSync(tmp, this.file); // write then swap: a crash never leaves half a file
      this.dirty = false;
    } catch { /* disk problem: keep learning in memory */ }
  }

  // ------------------------------------------------------------ recording
  seenGame(id: string): void { if (!this.data.games.includes(id)) { this.data.games.push(id); this.touch(); } }

  recordBattle(kind: TargetKind, ratio: number, won: boolean): void {
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    const cell = this.data.battles[kind][bucketOf(ratio)];
    if (won) cell.w++; else cell.l++;
    this.touch();
  }
  recordPeace(kind: TargetKind, accepted: boolean): void { const p = this.data.peace[kind]; p.offered++; if (accepted) p.ok++; this.touch(); }
  recordSent(text: string): void { const k = norm(text); (this.data.texts[k] ??= { sent: 0, replied: 0 }).sent++; this.trimTexts(); this.touch(); }
  recordReply(text: string): void { const k = norm(text); const t = (this.data.texts[k] ??= { sent: 1, replied: 0 }); t.replied++; this.touch(); }
  private trimTexts() {
    const keys = Object.keys(this.data.texts);
    if (keys.length > MAX_TEXTS) for (const k of keys.sort((a, b) => this.data.texts[a].sent - this.data.texts[b].sent).slice(0, keys.length - MAX_TEXTS)) delete this.data.texts[k];
  }
  recordCoalition(members: number, outcome: "applied" | "joined" | "refused", hours = 0): void {
    const c = (this.data.coalition[sizeBucket(members)] ??= { applied: 0, joined: 0, refused: 0, hours: 0 });
    if (outcome === "joined") { c.joined++; c.hours += hours; } else c[outcome]++;
    this.touch();
  }
  recordPrice(rid: string, price: number, now = Date.now()): void {
    if (!(price > 0)) return;
    const p = (this.data.prices[rid] ??= { fair: price, n: 0 });
    if (p.t !== undefined && now - p.t < 10 * 60_000) return; // one sample per 10 minutes: this is a memory of hours and games, not of the last few ticks
    p.t = now; p.fair = ewma(p.fair, price, 0.05, p.n); p.n++;
    if (p.n % 6 === 0) this.touch(); // prices change constantly: do not write on every sample
  }
  recordPace(day: number, vp: number, provinces: number, units: number, money: number): void {
    if (!(day >= 1)) return;
    const k = String(Math.floor(day));
    const p = this.data.pace[k];
    if (!p) this.data.pace[k] = { vp, provinces, units, money, n: 1 };
    else { const a = Math.max(0.05, 1 / (p.n + 1)); p.vp = ewma(p.vp, vp, a, p.n); p.provinces = ewma(p.provinces, provinces, a, p.n); p.units = ewma(p.units, units, a, p.n); p.money = ewma(p.money, money, a, p.n); p.n++; }
    if ((this.data.pace[k].n % 6) === 0) this.touch();
  }
  recordUnit(kind: "fielded" | "kill" | "lost" | "hours", name: string, amount: number, cost: number): void {
    const u = (this.data.units[name] ??= { fielded: 0, kills: 0, lost: 0, hours: 0, cost });
    if (kind === "fielded") u.fielded += amount; else if (kind === "kill") u.kills += amount; else if (kind === "lost") u.lost += amount; else u.hours += amount;
    u.cost = cost || u.cost;
    if (kind !== "hours") this.touch();
  }
  recordLoss(undefended: boolean): void { if (undefended) this.data.defence.undefended++; else this.data.defence.defended++; this.touch(); }
  recordParams(attackRatio: Record<string, number>, maxUnits: Record<string, number>): void {
    const p = this.data.params, n = p.n;
    const mix = (old: Record<string, number> | undefined, cur: Record<string, number>) => Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, ewma(old?.[k], v, 0.2, n)]));
    p.attackRatio = mix(p.attackRatio, attackRatio); p.maxUnits = mix(p.maxUnits, maxUnits); p.n++;
    this.touch();
  }
  addLesson(text: string): void {
    const body = text.includes("Lesson:") ? text.slice(text.indexOf("Lesson:") + 7) : text;
    const key = body.toLowerCase().replace(/[^a-z ]+/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!key) return;
    const hit = this.data.lessons.find((l) => l.key === key);
    if (hit) { hit.n++; hit.last = Date.now(); } else { this.data.lessons.push({ key, text: body.trim(), n: 1, last: Date.now() }); if (this.data.lessons.length > 60) this.data.lessons.sort((a, b) => b.n - a.n || b.last - a.last).length = 40; }
    this.touch();
  }

  // ------------------------------------------------------------ reading
  private battleRate(cell: WL) { return (cell.w + 1) / (cell.w + cell.l + 2); } // smoothed: an empty cell reads 50%
  battleCount(kind?: TargetKind): number { return (kind ? [kind] : (["ai", "human"] as TargetKind[])).reduce((n, k) => n + this.data.battles[k].reduce((a, c) => a + c.w + c.l, 0), 0); }

  /** Smallest strength ratio that has won at least 70% of the time, or null with too little evidence. */
  requiredRatio(kind?: TargetKind): number | null {
    const kinds: TargetKind[] = kind ? [kind] : ["ai", "human"];
    if (this.battleCount(kind) < 8) return null;
    for (let b = 0; b < EDGES.length; b++) {
      const cell = kinds.reduce<WL>((a, k) => ({ w: a.w + this.data.battles[k][b].w, l: a.l + this.data.battles[k][b].l }), { w: 0, l: 0 });
      if (cell.w + cell.l >= 3 && this.battleRate(cell) >= 0.7) return Math.max(0.8, EDGES[b]);
    }
    return 3;
  }
  /** How much harder (>1) or easier (<1) this kind of opponent is than the average one, from results. 1 when unknown. */
  ratioFactor(kind: TargetKind): number {
    const k = this.requiredRatio(kind), all = this.requiredRatio();
    if (k === null || all === null || all <= 0) return 1;
    return Math.min(1.4, Math.max(0.85, k / all));
  }
  peaceRate(kind: TargetKind): { rate: number; n: number } { const p = this.data.peace[kind]; return { rate: (p.ok + 1) / (p.offered + 3), n: p.offered }; }
  /** Wait longer between peace offers to a kind of player that has almost never accepted. */
  peaceGapFactor(kind: TargetKind): number { const p = this.peaceRate(kind); return p.n >= 8 && p.rate < 0.12 ? 3 : p.n >= 8 && p.rate < 0.25 ? 2 : 1; }
  /** Relative chance (0.5..1.6) that a coalition of this size takes me, from past applications. 1 when unknown. */
  coalitionFactor(members: number): number {
    const all = Object.values(this.data.coalition), tot = all.reduce((a, c) => ({ applied: a.applied + c.applied, joined: a.joined + c.joined }), { applied: 0, joined: 0 });
    const c = this.data.coalition[sizeBucket(members)];
    if (tot.applied < 6 || !c || c.applied < 2) return 1;
    const mine = (c.joined + 1) / (c.applied + 3), avg = (tot.joined + 1) / (tot.applied + 3);
    return Math.min(1.6, Math.max(0.5, mine / avg));
  }
  /** Smoothed answer rate of a wording; unseen wordings read 1/3 so they get tried. */
  textScore(text: string): number { const t = this.data.texts[norm(text)]; return t ? (t.replied + 1) / (t.sent + 3) : 1 / 3; }
  fairPrice(rid: string): number | null { const p = this.data.prices[rid]; return p && p.n >= 30 ? p.fair : null; }
  pace(day: number): { vp: number; provinces: number; units: number; money: number; n: number } | null { const p = this.data.pace[String(Math.floor(day))]; return p && p.n >= 3 ? p : null; }
  /** Starting values for a brand-new game's risk knobs, once earlier games have settled them. */
  seedParams(): { attackRatio: Record<string, number>; maxUnits: Record<string, number> } | null {
    const p = this.data.params;
    return p.n >= 3 && p.attackRatio && p.maxUnits ? { attackRatio: p.attackRatio, maxUnits: p.maxUnits } : null;
  }
  /** How much better (>1) or worse (<1) a unit type has done than the typical one, from kills, losses and value tied up. 1 until enough of them have fought. */
  unitFactor(name: string): number {
    const base = (n: string) => n.replace(/\s+lvl\.?\s*\d+/i, "").trim().toLowerCase();
    const score = (u: { kills: number; lost: number; hours: number; cost: number }) => (u.kills + 1) / (0.8 * u.lost + 1) / (1 + (u.cost * u.hours) / 1e5);
    const known = Object.entries(this.data.units).filter(([, u]) => u.fielded >= 3);
    if (known.length < 3) return 1;
    const me = known.find(([n]) => base(n) === base(name));
    if (!me) return 1;
    const scores = known.map(([, u]) => score(u)).sort((a, b) => a - b), median = scores[Math.floor(scores.length / 2)];
    return Math.min(1.6, Math.max(0.6, score(me[1]) / Math.max(0.01, median)));
  }
  undefendedShare(): number | null { const d = this.data.defence, n = d.undefended + d.defended; return n >= 5 ? d.undefended / n : null; }

  /** Everything the dashboard shows, in plain numbers. */
  summary() {
    const d = this.data;
    const bucketRows = (kind: TargetKind) => d.battles[kind].map((c, b) => ({ label: bucketLabel(b), won: c.w, lost: c.l, rate: c.w + c.l ? c.w / (c.w + c.l) : null }));
    const coal = Object.entries(d.coalition).map(([size, c]) => ({ size, applied: c.applied, joined: c.joined, refused: c.refused, avgHours: c.joined ? c.hours / c.joined : null }));
    const texts = Object.entries(d.texts).filter(([, t]) => t.sent >= 1).map(([text, t]) => ({ text, sent: t.sent, replied: t.replied, score: (t.replied + 1) / (t.sent + 3) })).sort((a, b) => b.score - a.score || b.sent - a.sent);
    return {
      games: d.games.length, updated: d.updated, battles: this.battleCount(),
      battleRows: { ai: bucketRows("ai"), human: bucketRows("human") },
      required: { all: this.requiredRatio(), ai: this.requiredRatio("ai"), human: this.requiredRatio("human") },
      peace: { ai: { ...d.peace.ai, rate: this.peaceRate("ai").rate }, human: { ...d.peace.human, rate: this.peaceRate("human").rate } },
      coalition: coal, texts: { best: texts.slice(0, 4), worst: texts.filter((t) => t.sent >= 2 && t.replied === 0).slice(0, 4), total: texts.length },
      prices: Object.entries(d.prices).filter(([, p]) => p.n >= 30).map(([rid, p]) => ({ rid, fair: p.fair })),
      pace: Object.entries(d.pace).filter(([, p]) => p.n >= 3).map(([day, p]) => ({ day: Number(day), ...p })).sort((a, b) => a.day - b.day),
      defence: { ...d.defence, undefendedShare: this.undefendedShare() },
      params: d.params.n ? d.params : null,
      lessons: [...d.lessons].sort((a, b) => b.n - a.n || b.last - a.last).slice(0, 8),
      units: Object.entries(d.units ?? {}).map(([name, u]) => ({ name, ...u, kd: u.kills / Math.max(1, u.lost), score: (u.kills + 1) / (0.8 * u.lost + 1) / (1 + (u.cost * u.hours) / 1e5) })).filter((u) => u.fielded >= 1).sort((a, b) => b.score - a.score).slice(0, 12),
    };
  }
}

/** The one shared instance every game in this process reads and writes. */
export const kb = new Knowledge();
