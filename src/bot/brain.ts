// Strategy brain: pure functions. (state, settings, options, memory) -> Decision[]
// No I/O here so every decision is explainable on the dashboard and testable offline.
import { unitRangeKm } from "./rules.js";
import { learnedDefence, weaknessMultiplier, type PlayerIntel } from "./intel.js";
import { compose, isGreeting, remember, type MsgKind } from "./messages.js";
import { R, type Army, type Decision, type GameState, type Memory, type Prov, type Settings } from "./types.js";

export interface ResearchOpt { id: number; name: string; costs: Record<string, number>; canStart: boolean | null }
export interface UpgradeOpt { id: number; name: string; costs: Record<string, number>; daily: Record<string, number> }
export interface ProdOpt { id: number; name: string; type: string; costs: Record<string, number>; daily: Record<string, number>; ship: boolean; air: boolean; buildTime: number }
export interface ProvOptions { upgrades: UpgradeOpt[]; productions: ProdOpt[] }

type Budget = Record<string, number>;

import { upgradeHours as buildHours } from "./rules.js";

const sumCost = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
const fits = (b: Budget, c: Record<string, number>, reserve: Record<string, number>) =>
  Object.entries(c).every(([k, v]) => (b[k] ?? 0) - (reserve[k] ?? 0) >= v);
const spend = (b: Budget, c: Record<string, number>) => { for (const [k, v] of Object.entries(c)) b[k] = (b[k] ?? 0) - v; };
/** What I'm short of: resource id -> units missing for the best things I wanted to buy but couldn't afford. Feeds the market. */
export type Shortfall = Record<string, number>;
/** What the bot is waiting to afford: the specific items (in priority order) and what each one lacks. Attached to the Shortfall object. */
export interface Waiting { label: string; lacks: Record<string, number> }
const WAITING = new WeakMap<object, Waiting[]>();
export const waitingOf = (sink: object | undefined): Waiting[] => (sink ? WAITING.get(sink) ?? [] : []);
const noteShort = (sink: Shortfall | undefined, b: Budget, c: Record<string, number>, reserve: Record<string, number>, includeMoney = true, label?: string) => {
  if (!sink) return;
  const lacks: Record<string, number> = {};
  for (const [k, v] of Object.entries(c)) {
    if (k === R.MONEY && !includeMoney) continue; // money cannot be bought; an expensive build lacking it must not stop the market buying inputs for units
    const lack = v - ((b[k] ?? 0) - (reserve[k] ?? 0));
    if (lack > 0) { sink[k] = Math.max(sink[k] ?? 0, lack); lacks[k] = lack; } // max, not sum: the same stock serves one item after another
  }
  if (label && Object.keys(lacks).length) {
    const list = WAITING.get(sink) ?? [];
    const kind = (l: string) => l.split(" in ")[0]; // "Build Arms Industry in Huế" and "... in Hanoi" are the same thing to wait for
    if (list.length < 4 && !list.some((w) => kind(w.label) === kind(label))) list.push({ label, lacks });
    WAITING.set(sink, list);
  }
};
const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

export function budgetOf(s: GameState): Budget {
  const b: Budget = {};
  for (const [id, r] of Object.entries(s.resources)) b[id] = r.amount;
  return b;
}

// ---------------------------------------------------------------- RESEARCH
const WMD = /nuclear|chemical|icbm|ballistic|guided missile program|warhead|contaminat/i;
const RESEARCH_RULES: [RegExp, number][] = [
  [/basic infantry veteran/i, 30], [/veteran|engine|upgrade|armor plating/i, 4],
  [/mechanized/i, 92], [/bmp|btr|brdm|bradley|stryker|ifv|apc/i, 74], [/\bt-\d+|tank|abrams|leopard|leclerc|merkava|challenger/i, 82],
  [/neva|strela|zsu|tor|pantsir|aa\b|anti-air|sam|hawk|shilka|vads/i, 62], [/howitzer|grad|akatsiya|sprut|artiller|mlrs|rocket/i, 55],
  [/airborne|spetsnaz|ranger|marines|special forces/i, 38], [/national guard|infantry/i, 34],
  [/helicopter|ka-\d+|mi-\d+|ah-|black shark|gunship/i, 33],
  [/mig|su-\d+|f-\d+|fighter|fencer|flogger/i, 32], [/bomber|tu-\d+/i, 14], [/class|corvette|destroyer|cruiser|frigate|submarine|navy/i, 8],
];

export interface LabHint { airShare: number; seaShare: number; mAir: number; mSea: number }
const AIR_RES_RE = /mig|su-\d+|f-\d+|fighter|helicopter|ka-\d+|mi-\d+|ah-|gunship|bomber|tu-\d+/i;
const NAVAL_RE = /marines|amphibious|transport|helicopter carrier|landing|destroyer|frigate|corvette|cruiser|class\b/i;

/** seaMode: no reachable land targets -> boost naval / amphibious research so we can expand overseas. */
export function planResearch(s: GameState, st: Settings, opts: ResearchOpt[], budget: Budget, seaMode = false, short?: Shortfall, lab?: LabHint): Decision[] {
  const out: Decision[] = [];
  let free = s.research.freeSlots;
  if (free <= 0) return out;
  const scored = opts
    .filter((o) => o.canStart !== false && (st.allowWmd || !WMD.test(o.name)))
    .map((o) => {
      let w = RESEARCH_RULES.find(([re]) => re.test(o.name))?.[1] ?? 10;
      if (seaMode && NAVAL_RE.test(o.name) && !/veteran|upgrade/i.test(o.name)) w = Math.max(w, 58);
      if (lab && !/veteran|upgrade/i.test(o.name)) {
        // learned: air / naval research is worth what the ledger says those classes actually earn
        if (AIR_RES_RE.test(o.name)) w = Math.max(w, lab.airShare > 0 ? 45 : 0) * (lab.airShare > 0 ? lab.mAir : 0.6);
        else if (NAVAL_RE.test(o.name) && lab.seaShare > 0) w = Math.max(w, 36 * lab.mSea);
      }
      const cost = sumCost(o.costs);
      const tier = /lvl\. ?(\d)/i.exec(o.name)?.[1];
      const tierPenalty = tier ? 1 + (Number(tier) - 1) * 0.15 : 1;
      return { o, score: (w * (st.weights[o.name] ?? 1)) / (1 + cost / 4000) / tierPenalty };
    })
    .sort((a, b) => b.score - a.score);
  let noted = 0;
  for (const { o, score } of scored) {
    if (free <= 0) break;
    // Low-value research (generic upgrades, radar...) only when money is comfortable; otherwise the money builds units and economy.
    if (score < 8 && (budget[R.MONEY] ?? 0) < 6000) continue;
    if (!fits(budget, o.costs, st.reserve)) { if (noted++ < 2) noteShort(short, budget, o.costs, st.reserve, false, `Research ${o.name}`); continue; }
    spend(budget, o.costs);
    free--;
    out.push({ kind: "research", args: [o.id], label: `Research ${o.name}`, reason: `priority ${score.toFixed(1)} (cost ${sumCost(o.costs)})`, cost: o.costs });
  }
  return out;
}

// ---------------------------------------------------------------- BUILDINGS
const SKIP_BUILD = /hive|complex|invisible|contaminator|decontaminator|relocate|secret weapons|command post|radiation|dome|crater|colon|annex|missile|silo/i;
const ARMY_BASE_IDS = new Set([2250, 2251, 2252, 2253, 2254]);
const AIR_BASE_IDS = new Set([2255, 2256, 2257, 2258, 2259]);
const NAVAL_BASE_IDS = new Set([2260, 2261, 2262, 2263, 2264]);

/** Hop distance from every owned province to the nearest province I do not own. */
export function frontierDistance(s: GameState): Map<number, number> {
  const mine = new Set(s.provinces.map((p) => p.id));
  const adj = new Map<number, number[]>();
  for (const p of [...s.provinces, ...s.frontier]) adj.set(p.id, p.adj);
  const d = new Map<number, number>();
  const q: number[] = [];
  for (const p of s.frontier) { d.set(p.id, 0); q.push(p.id); }
  while (q.length) {
    const cur = q.shift()!;
    for (const n of adj.get(cur) ?? []) {
      if (!mine.has(n) || d.has(n)) continue;
      d.set(n, (d.get(cur) ?? 0) + 1);
      q.push(n);
    }
  }
  return d;
}

export function planBuilds(s: GameState, st: Settings, options: Map<number, ProvOptions>, budget: Budget, blocked: Record<string, number> = {}, short?: Shortfall, lab?: LabHint): Decision[] {
  const out: Decision[] = [];
  const fd = frontierDistance(s);
  const airBases = s.provinces.filter((p) => p.have?.some((i) => AIR_BASE_IDS.has(i))).length;
  const navalBases = s.provinces.filter((p) => p.have?.some((i) => NAVAL_BASE_IDS.has(i))).length;
  const armyBases = s.provinces.filter((p) => p.have?.some((i) => ARMY_BASE_IDS.has(i))).length;
  const wantBases = st.mode === "economy" ? 2 : st.mode === "balanced" ? 4 : 6;
  const cand: { p: Prov; u: UpgradeOpt; score: number }[] = [];

  for (const p of s.provinces) {
    if (!p.freeSlot) continue;
    if ((blocked["prov:" + p.id] ?? 0) > Date.now()) continue; // just (re)captured: contested, and the server often ignores builds there
    const opt = options.get(p.id);
    if (!opt) continue;
    const near = fd.get(p.id) ?? 9;
    for (const u of opt.upgrades) {
      if (SKIP_BUILD.test(u.name)) continue;
      if (Object.keys(u.costs).length === 0) continue; // an upgrade with no cost data cannot be queued (accepted by the server, never started)
      if (p.have?.includes(u.id)) continue; // already built: ordering it again is a silent no-op
      if ((blocked["build:" + p.id + ":" + u.id] ?? 0) > Date.now()) continue;
      const key = Object.keys(st.weights).find((k) => u.name.startsWith(k));
      if (!key) continue;
      let w = st.weights[key];
      if (key === "Army Base") w = p.city && near <= 2 && armyBases < wantBases && !p.have?.some((i) => ARMY_BASE_IDS.has(i)) ? w : 0;
      if (key === "Air Base") w = lab && lab.airShare > 0 ? (p.city && near >= 1 ? (airBases === 0 ? 70 : 28) * lab.mAir : w) : w * 0.5;
      if (key === "Naval Base") w = lab && lab.seaShare > 0 ? (navalBases === 0 ? 55 : 20) * lab.mSea : w * 0.5;
      if (key === "Recruiting Office") w = (s.resources[R.MAN]?.perHour ?? 0) < 60 ? w : w * 0.3;
      if (key === "Local Industry") w = (p.resType ?? 0) > 0 && (p.resType ?? 0) !== 3 && (p.resType ?? 0) !== 20 ? w : 0;
      // Low morale cuts production and breeds insurgents (wiki): Field Hospitals / Combat Outposts raise it, so favour them where morale is poor.
      const lowMorale = p.morale < 50;
      if (key === "Combat Outpost" || key === "Field Hospital") w = lowMorale ? Math.max(w, 30) * (key === "Field Hospital" ? 2.2 : 1.4) : near <= 1 ? w : 0;
      if (key === "Military Hospital") w = near <= 2 ? w : w * 0.3;
      if (key === "Underground Bunkers") w = p.id === s.me.capital && st.mode !== "economy" ? w : 0;
      if (p.city) w *= 1.25; // cities carry the economy
      if (w <= 0) continue;
      const hours = buildHours(u.id);
      if (hours > 96) continue; // would lock the only construction slot for days
      const cost = Math.max(500, sumCost(u.costs));
      cand.push({ p, u, score: (w * 1000) / cost / (1 + hours / 36) });
    }
  }
  cand.sort((a, b) => b.score - a.score);
  const used = new Set<number>();
  let n = 0, noted = 0;
  for (const c of cand) {
    if (n >= 6) break;
    if (used.has(c.p.id)) continue;
    if (!fits(budget, c.u.costs, st.reserve)) { if (noted++ < 3) noteShort(short, budget, c.u.costs, st.reserve, false, `Build ${c.u.name} in ${c.p.name}`); continue; }
    spend(budget, c.u.costs);
    used.add(c.p.id);
    n++;
    out.push({ kind: "build", args: [c.p.id, c.u.id], label: `Build ${c.u.name} in ${c.p.name}`, reason: `value ${c.score.toFixed(1)}`, cost: c.u.costs });
  }
  return out;
}

// ---------------------------------------------------------------- MOBILIZATION
type Role = "inf" | "armor" | "arty" | "aa" | "air" | "sea";
const LAND_MIX: Record<"inf" | "armor" | "arty" | "aa", number> = { inf: 0.5, armor: 0.25, arty: 0.12, aa: 0.13 };
const AIR_RE = /fighter|bomber|gunship|attack helicopter/i;
const SEA_RE = /destroyer|frigate|corvette|cruiser|patrol boat|attack submarine/i;

export function roleOf(p: { name: string; type: string; ship?: boolean; air?: boolean }): Role | null {
  const t = `${p.type} ${p.name}`;
  if (/officer|radar|drone|mercenary|launcher|missile|munition|warhead|deployable|fortif|emplacement|satellite|awacs|uav|veteran|transport|carrier|patrol aircraft|asw|ballistic/i.test(t)) return null;
  if (!/tank/i.test(t) && (p.ship || SEA_RE.test(t))) return SEA_RE.test(t) ? "sea" : null;
  if (p.air || AIR_RE.test(t)) return AIR_RE.test(t) ? "air" : null;
  if (/anti-air|sam|air defense|theater defense/i.test(t)) return "aa";
  if (/artillery|howitzer|rocket/i.test(t)) return "arty";
  if (/tank|armored|combat recon|amphibious|destroyer/i.test(t)) return "armor";
  if (/infantry|guard|rangers|special forces|airborne|marines|mechanized/i.test(t)) return "inf";
  return null;
}

export function roleOfUnitName(n: string): Role | null { return roleOf({ name: n, type: n }); }

export function planMobilize(s: GameState, st: Settings, options: Map<number, ProvOptions>, budget: Budget, blocked: Record<string, number> = {}, short?: Shortfall, lab?: LabHint, emergency = false): Decision[] {
  const out: Decision[] = [];
  const have = s.armies.reduce((a, x) => a + x.units.length, 0);
  const inProd = s.provinces.reduce((a, p) => a + (p.producing ?? 0), 0);
  let room = st.maxUnits[st.mode] - have - inProd;
  if (room <= 0) return out;

  // current role counts (by unit names is unavailable for armies -> approximate with production names tracked by runner); use equal weights when unknown
  const counts: Record<Role, number> = { inf: 0, armor: 0, arty: 0, aa: 0, air: 0, sea: 0 };
  for (const a of s.armies) for (const u of a.units) { const r = roleOfUnitName(u.n ?? ""); if (r) counts[r]++; }
  const total = Math.max(1, counts.inf + counts.armor + counts.arty + counts.aa + counts.air + counts.sea);
  // Target mix: air / sea shares are learned (lab); land roles split the rest.
  const airShare = lab?.airShare ?? 0, seaShare = lab?.seaShare ?? 0;
  const landScale = 1 - airShare - seaShare;
  const MIX: Record<Role, number> = { inf: LAND_MIX.inf * landScale, armor: LAND_MIX.armor * landScale, arty: LAND_MIX.arty * landScale, aa: LAND_MIX.aa * landScale, air: airShare, sea: seaShare };
  // air and sea units are expensive: only buy them with a comfortable margin over the reserve
  const richReserve = Object.fromEntries(Object.entries(st.reserve).map(([k, v]) => [k, v * 2]));
  // War footing: the capital is under a much stronger threat -> units now, reserves be damned (keep a sliver so upkeep never starves).
  // A critically small army (under 8 units incl. those in training) is a bigger risk than a thin cushion: keep only a quarter of the usual reserve.
  const tiny = have + inProd < 8;
  const baseReserve = emergency ? Object.fromEntries(Object.entries(st.reserve).map(([k, v]) => [k, v * 0.15]))
    : tiny ? Object.fromEntries(Object.entries(st.reserve).map(([k, v]) => [k, v * 0.25])) : st.reserve;
  const capital = s.provinces.find((p) => p.id === s.me.capital);
  const order = emergency && capital ? [...s.provinces].sort((a, b) => dist(a.x, a.y, capital.x, capital.y) - dist(b.x, b.y, capital.x, capital.y)) : s.provinces;

  // net-income guard: never mobilize into a negative economy
  const net = (id: string) => s.resources[id]?.perHour ?? 0;

  for (const p of order) {
    if (room <= 0) break;
    if (!p.canMob) continue;
    if ((p.producing ?? 0) >= (p.prodSlots ?? 1)) continue;
    const opt = options.get(p.id);
    if (!opt?.productions.length) continue;
    const roles = (Object.keys(MIX) as Role[]).filter((r) => MIX[r] > 0).sort((a, b) => counts[a] / total - MIX[a] - (counts[b] / total - MIX[b]));
    let picked: { u: ProdOpt; role: Role } | null = null;
    for (const role of roles) {
      const cands = opt.productions
        .filter((u) => roleOf(u) === role && (st.allowWmd || !WMD.test(u.name)))
        .filter((u) => (blocked["mobilize:" + p.id + ":" + u.id] ?? 0) <= Date.now())
        .filter((u) => (emergency && (role === "air" || role === "sea")) ? false : fits(budget, u.costs, role === "air" || role === "sea" ? richReserve : baseReserve))
        .filter((u) => Object.entries(u.daily).every(([k, v]) => net(k) - v / 24 > -Math.abs(net(k)) * 0.5 - 15 || k === R.FUEL))
        .sort((a, b) => sumCost(b.costs) - sumCost(a.costs)); // best affordable tier
      if (cands.length) { picked = { u: cands[0], role }; break; }
    }
    if (!picked) {
      // Nothing affordable: remember what the cheapest sensible unit lacks so the market can supply it.
      const cheapest = opt.productions.filter((u) => roleOf(u) !== null && (st.allowWmd || !WMD.test(u.name))).sort((a, b) => sumCost(a.costs) - sumCost(b.costs))[0];
      if (cheapest) noteShort(short, budget, cheapest.costs, baseReserve, true, `Train ${cheapest.name} in ${p.name}`);
      continue;
    }
    spend(budget, picked.u.costs);
    counts[picked.role]++; room--;
    out.push({ kind: "mobilize", args: [p.id, picked.u.id], label: `Mobilize ${picked.u.name} in ${p.name}`, reason: `role ${picked.role} (${(counts[picked.role] / total * 100).toFixed(0)}% of force, target ${(MIX[picked.role] * 100).toFixed(0)}%)`, cost: picked.u.costs, meta: { role: picked.role } });
  }
  return out;
}

// ---------------------------------------------------------------- MILITARY
export interface Target { prov: Prov; ownerRel: number | undefined; estDef: number; value: number }

const isTeamOrAlly = (s: GameState, pid: number) => {
  const p = s.players.find((x) => x.id === pid);
  if (!p) return false;
  return (p.rel ?? -99) >= 3 || (s.me.team > 0 && p.team === s.me.team);
};

export function eligibleTarget(s: GameState, st: Settings, owner: number): boolean {
  if (owner === s.me.id || st.protectedPlayers.includes(owner)) return false;
  if (isTeamOrAlly(s, owner)) return false;
  if (st.warPolicy === "none") return false;
  const p = s.players.find((x) => x.id === owner);
  if (!p) return owner === 0; // neutral / insurgent
  if (st.warPolicy === "ai_only") return !p.human;
  return true;
}

export function findTargets(s: GameState, st: Settings, mem: Memory, intel: Record<number, PlayerIntel> = {}): Target[] {
  const out: Target[] = [];
  const now = Date.now();
  const camp = campaignStep(s, st, mem);
  for (const f of s.frontier) {
    if (!eligibleTarget(s, st, f.owner)) continue;
    if (camp.only && f.name.trim().toLowerCase() !== camp.only) continue; // campaign step 1: only the named province
    if (camp.spare.has(f.owner)) continue; // campaign step 2: players I am making peace with are left alone
    if ((mem.failedTargets[f.id] ?? 0) > now - 10 * 60_000) continue;
    if ((mem.truce[f.owner] ?? 0) > now) continue; // I asked this owner for peace while outgunned: do not provoke them meanwhile
    const visible = s.otherArmies.filter((a) => a.loc === f.id && a.owner === f.owner && !a.air).reduce((x, a) => x + a.def, 0);
    const p = s.players.find((x) => x.id === f.owner);
    const ii = intel[f.owner];
    if (ii?.defeated) continue;
    // an owner who has not moved for many hours will not reinforce: trust what I can see rather than the cautious guess
    const idle = ii?.inactiveHours != null && ii.inactiveHours >= 12;
    const baseline = (f.city ? 7 : 3) * (idle ? 0.6 : 1);
    const campaignBoost = camp.focus.has(f.owner) ? (st.campaign.cities ? (f.city ? 6 : 0.4) : 3) : 1; // campaign step 3: their cities first
    out.push({ prov: f, ownerRel: p?.rel, estDef: Math.max(visible, baseline, learnedDefence(mem.enemy, f.owner)), value: (f.vp || 1) * (st.targetPlayers.includes(f.owner) ? 2 : 1) * (p && p.human ? 0.6 : 1) * weaknessMultiplier(ii) * campaignBoost });
  }
  return out.sort((a, b) => b.value / (1 + b.estDef) - a.value / (1 + a.estDef));
}

/** Ground armies that may be given a new job: idle (or on an old order), not fighting, not home-guarding a threatened city, and not the lone garrison of a valuable city. */
export function freeGroundArmies(s: GameState, mem: Memory, exclude: Set<string | number> = new Set()): Army[] {
  const fd = frontierDistance(s);
  const ground = (a: Army) => !a.air && !a.sea;
  // Free = ground, not fighting, not reserved by defence, and either idle or marching on leftover orders
  // that the bot did not assign (its own assignments are left alone for 3h so attacks aren't diluted).
  const busyByBot = (a: Army) => { const x = mem.assigned[String(a.id)]; return !!x && Date.now() - x.t < 3 * 3600_000; };
  // Home guard: armies close to a city that a much stronger stack is threatening stay put rather than wander off to attack elsewhere
  const danger = assessThreats(s).filter((t) => t.threat >= 8 && t.ratio >= 1.5).map((t) => s.provinces.find((p) => p.id === t.id)!).filter(Boolean);
  const homeGuard = (a: Army) => danger.some((p) => dist(a.x, a.y, p.x, p.y) < 130);
  const idle = s.armies.filter((a) => ground(a) && !a.fight && !exclude.has(a.id) && !homeGuard(a) && (!a.moving || !busyByBot(a)));
  const provById = new Map(s.provinces.map((p) => [p.id, p]));
  const garrison = new Set<string | number>();
  const perProv = new Map<number, Army[]>();
  for (const a of idle) { const l = perProv.get(a.loc) ?? []; l.push(a); perProv.set(a.loc, l); }
  for (const [loc, list] of perProv) {
    const p = provById.get(loc);
    const recent = (mem.capturedAt[loc] ?? 0) > Date.now() - 6 * 3600_000;
    if (p && (recent || (p.city && (fd.get(loc) ?? 9) <= 1) || p.id === s.me.capital || p.morale < 45)) {
      const keep = list.sort((a, b) => b.def - a.def)[0];
      garrison.add(keep.id);
    }
  }
  return idle.filter((a) => !garrison.has(a.id));
}

export function planMilitary(s: GameState, st: Settings, mem: Memory, exclude: Set<string | number> = new Set(), intel: Record<number, PlayerIntel> = {}): Decision[] {
  const out: Decision[] = [];
  if (st.mode === "economy" && s.day < 3) return out; // build up first
  const fd = frontierDistance(s);
  const ground = (a: Army) => !a.air && !a.sea;
  const targets = findTargets(s, st, mem, intel);
  if (!targets.length) return out;

  // An order that "succeeds" can still do nothing (the game may be waiting for a war-declaration confirmation, as in games where
  // nobody is at war by default). So: an army that is moving has taken its order; one that is not, after an order, has not.
  const now0 = Date.now();
  const declaredOwners = new Set<number>();
  for (const a of s.armies) if (a.moving || a.fight) delete mem.moveTries[String(a.id)];

  let free = freeGroundArmies(s, mem, exclude);
  if (!free.length) return out;

  const ratio = st.attackRatio[st.mode];
  for (const t of targets.slice(0, 3)) {
    // gather nearest free armies until strength is sufficient
    const sorted = [...free].sort((a, b) => dist(a.x, a.y, t.prov.x, t.prov.y) - dist(b.x, b.y, t.prov.x, t.prov.y));
    const group: Army[] = [];
    let str = 0;
    // an owner that has been idle for hours gets a slightly lower margin (it will not reinforce); the tuner still corrects failures
    const ii = intel[t.prov.owner];
    const need = ratio * t.estDef * (ii?.inactiveHours != null && ii.inactiveHours >= 12 ? 0.85 : 1);
    for (const a of sorted) { group.push(a); str += a.str; if (str >= need) break; }
    if (str < need) {
      out.push({ kind: "move", args: [], label: `Hold: ${t.prov.name} needs strength ${need.toFixed(1)} (have ${str.toFixed(1)})`, reason: "insufficient force" + (ii && ii.weakness > 0.8 ? ` (weak owner: ${ii.why.slice(0, 2).join(", ")})` : ""), cost: {} });
      continue;
    }
    const owner = s.players.find((p) => p.id === t.prov.owner);
    const atWar = (owner?.rel ?? -2) <= -2; // no stance recorded = default war
    if (!atWar && owner && st.doDiplomacy && (mem.warDeclaredAt[owner.id] ?? 0) < Date.now() - 3600_000) {
      out.push({ kind: "relation", args: [owner.id, -2], label: `Declare war on ${owner.nation} (${owner.name})`, reason: `target ${t.prov.name} (VP ${t.prov.vp}); policy ${st.warPolicy}`, cost: {} });
      break; // wait for the declaration to register before moving
    }
    if (!atWar && owner) continue;
    let backedOff = false;
    for (const a of group) {
      const key = "move:" + a.id + ":" + t.prov.id;
      if ((mem.blocked[key] ?? 0) > now0) { backedOff = true; continue; }
      const tr = mem.moveTries[String(a.id)];
      if (tr && tr.target === t.prov.id && now0 - tr.t < 20 * 60_000) { // I already ordered this and the army did not start moving
        if (tr.n >= 2) { mem.blocked[key] = now0 + 2 * 3600_000; delete mem.moveTries[String(a.id)]; backedOff = true; continue; }
        if (!tr.declared) {
          tr.declared = true;
          if (owner && st.doDiplomacy && !declaredOwners.has(owner.id)) { declaredOwners.add(owner.id); out.push({ kind: "relation", args: [owner.id, -2], label: `Declare war on ${owner.nation} (${owner.name})`, reason: `my attack order on ${t.prov.name} did not take effect: the game probably wants a war declaration first`, cost: {} }); }
          continue;
        }
      }
      out.push({ kind: "move", args: [a.id, t.prov.x, t.prov.y], label: `Attack ${t.prov.name} with ${a.name || a.id} (str ${a.str.toFixed(1)})`, reason: `force ${str.toFixed(1)} vs est. defence ${t.estDef.toFixed(1)}, VP ${t.prov.vp}` + (ii && ii.weakness > 0.8 ? `; weak owner: ${ii.why.slice(0, 2).join(", ")}` : ""), cost: {}, meta: { target: t.prov.id } });
    }
    if (backedOff) out.push({ kind: "move", args: [], label: `Hold: orders against ${t.prov.name} are not taking effect`, reason: "declared war and retried; backing off for 2h on the armies that still do not move", cost: {} });
    free = free.filter((a) => !group.includes(a));
    if (!free.length) break;
  }
  return out;
}

// ---------------------------------------------------------------- TRUCE
/**
 * Keep my word: once I have offered an owner a truce ("I'll stand my armies down"), armies still marching on older attack orders
 * against that owner's provinces are halted where they stand (a move order to their own position cancels the path).
 */
export function planTruceHalts(s: GameState, mem: Memory): Decision[] {
  const now = Date.now();
  const out: Decision[] = [];
  const ownerOf = new Map<number, number>();
  for (const p of s.frontier) ownerOf.set(p.id, p.owner);
  for (const a of s.armies) {
    if (a.air || a.sea || !a.moving || a.fight) continue;
    const job = mem.assigned[String(a.id)];
    if (!job || job.target <= 0 || now - job.t > 12 * 3600_000) continue;
    const owner = ownerOf.get(job.target);
    if (owner === undefined || (mem.truce[String(owner)] ?? 0) <= now) continue;
    out.push({ kind: "move", args: [a.id, a.x, a.y], label: `Halt ${a.name || a.id}: truce with ${s.players.find((p) => p.id === owner)?.nation ?? owner}`, reason: "I offered them a truce, so I stop marching on their provinces", cost: {}, meta: { role: "halt" } });
    delete mem.assigned[String(a.id)];
  }
  return out;
}

// ---------------------------------------------------------------- RALLY (concentrate force)
/**
 * One strong stack beats the same strength spread over many provinces, so idle armies that did not get an attack job gather at a rally city.
 * The rally city is my city nearest the strongest visible enemy stack (so the stack also defends), else nearest the best target, else the capital.
 * Only runs when the force is actually fragmented (no army holds most of the strength) and never moves the last garrison of a valuable city.
 */
export function planRally(s: GameState, st: Settings, mem: Memory, intel: Record<number, PlayerIntel> = {}, used: Set<string | number> = new Set()): Decision[] {
  if (st.mode === "economy" && s.day < 2) return [];
  const now = Date.now();
  const free = freeGroundArmies(s, mem, used).filter((a) => !used.has(a.id));
  if (free.length < 3) return [];
  const total = free.reduce((x, a) => x + a.str, 0);
  const biggest = Math.max(...free.map((a) => a.str));
  if (biggest >= 0.6 * total) return []; // already concentrated
  const hostile = s.otherArmies.filter((e) => !e.removed && !e.air && !e.sea && e.owner !== s.me.id && e.owner !== 0 && !isTeamOrAlly(s, e.owner));
  const cities = s.provinces.filter((p) => p.city || p.id === s.me.capital);
  if (!cities.length) return [];
  let anchor: { x: number; y: number } | null = null;
  const foe = [...hostile].sort((x, y) => y.str - x.str)[0];
  if (foe && foe.str >= 8 && cities.some((c) => dist(c.x, c.y, foe.x, foe.y) < 300)) anchor = foe;
  if (!anchor) { const t = findTargets(s, st, mem, intel)[0]; if (t) anchor = t.prov; }
  if (!anchor) anchor = cities.find((c) => c.id === s.me.capital) ?? cities[0];
  const rally = [...cities].sort((x, y) => dist(x.x, x.y, anchor!.x, anchor!.y) - dist(y.x, y.y, anchor!.x, anchor!.y))[0];
  const out: Decision[] = [];
  const movers = free.filter((a) => dist(a.x, a.y, rally.x, rally.y) > 45).sort((x, y) => dist(y.x, y.y, rally.x, rally.y) - dist(x.x, x.y, rally.x, rally.y));
  for (const a of movers.slice(0, 4)) {
    out.push({ kind: "move", args: [a.id, rally.x, rally.y], label: `Gather ${a.name || a.id} at ${rally.name}`, reason: `force is scattered (biggest army ${biggest.toFixed(1)} of ${total.toFixed(1)} total); concentrating at ${rally.name}${foe && anchor === foe ? " near the strongest enemy stack" : ""}`, cost: {}, meta: { role: "rally", aim: rally.id } });
  }
  void now;
  return out;
}

// ---------------------------------------------------------------- AIR & SEA OPERATIONS
const KM_PER_MAP_UNIT = 2.8; // map scale measured on this world map (414 map units ~ 1150 km between two known cities)
const SORTIE_COOLDOWN_H = 4;
const unitsOnly = (a: Army, role: Role) => a.units.length > 0 && a.units.every((u) => roleOfUnitName(u.n ?? "") === role);

/**
 * Cautious employment of air and naval armies. Air units are only sent a short way (well inside the flight range, so they can get back),
 * at enemy armies that threaten my provinces or are fighting my attackers. Ships only engage enemy ships near my coast.
 * Sorties are rate-limited; the learning ledger (lab.ts) decides over time whether these classes get more or less investment.
 */
export function planAirSea(s: GameState, st: Settings, mem: Memory): Decision[] {
  const out: Decision[] = [];
  if (st.mode === "economy") return out;
  const now = Date.now();
  const hostile = (owner: number) => owner !== s.me.id && !isTeamOrAlly(s, owner) && !st.protectedPlayers.includes(owner);
  const enemies = s.otherArmies.filter((e) => !e.removed && hostile(e.owner));
  const myProv = new Set(s.provinces.map((p) => p.id));
  const attackTargets = new Set(mem.attacks.filter((x) => now - x.t < 3 * 3600_000).map((x) => x.target));
  const used = new Set<string | number>();

  for (const role of ["air", "sea"] as const) {
    const fleet = s.armies.filter((a) => (role === "air" ? a.air : a.sea) && !a.removed && !a.moving && !a.fight && a.hp >= 0.7 * a.maxhp && unitsOnly(a, role));
    for (const a of fleet) {
      if (used.has(a.id)) continue;
      const last = mem.assigned[String(a.id)];
      if (last && now - last.t < SORTIE_COOLDOWN_H * 3600_000) continue;
      const rangeKm = Math.min(...a.units.map((u) => unitRangeKm(u.n)));
      // stay well inside range: air units must return to base; ships fight near home waters
      const reach = (role === "air" ? rangeKm * 0.4 : Math.min(rangeKm, 150)) / KM_PER_MAP_UNIT;
      const near = enemies
        .filter((e) => (role === "air" ? true : e.sea) && dist(a.x, a.y, e.x, e.y) <= reach)
        .map((e) => {
          const defending = myProv.has(e.loc) ? 2 : 1; // enemy standing in my land first
          const supporting = attackTargets.has(e.loc) ? 1.5 : 1;
          return { e, score: defending * supporting * (1 / (1 + e.def)) * (1 - dist(a.x, a.y, e.x, e.y) / (reach + 1)) };
        })
        .filter((x) => x.e.def <= 4 * a.str) // ground units: unknown matchup, so only pick on things not wildly stronger; the ledger will adjust spending if this loses
        .sort((x, y) => y.score - x.score);
      const pick = near[0];
      if (!pick) continue;
      used.add(a.id);
      out.push({
        kind: "move", args: [a.id, pick.e.x, pick.e.y],
        label: `${role === "air" ? "Air sortie" : "Naval sortie"}: ${a.name || a.id} -> enemy army near ${pick.e.loc}`,
        reason: `range ${Math.round(reach * KM_PER_MAP_UNIT)} km, enemy def ${pick.e.def.toFixed(1)} vs my str ${a.str.toFixed(1)}`,
        cost: {}, meta: { role, aim: pick.e.loc },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- DIPLOMACY & MESSAGES
export interface InboxMsg { uid: number; from: number; to: number; body: string; time: unknown; read: boolean; mine: boolean }

const PEACE_RE = /peace|truce|cease|non.?aggress|nap\b|friend|stop attack|don'?t attack/i;
const ALLY_RE = /ally|alliance|coalition|team up|join us|join my/i;
const INVITE_RE = /(join|come (in|to)|enter|be part of)\b.{0,25}\b(coalition|alliance|team|us)\b|\b(my|our) (coalition|alliance)\b/i; // an invitation, even when it ends in a question mark
const TRADE_RE = /trade|sell|buy|resources|supplies|exchange|swap/i;
const QUESTION_RE = /\?|\b(why|how|what|who|when|where|are you|did you|do you|can you|will you)\b/i;
const ACCUSE_RE = /declared (first|war)|u declared|you declared|started it|attacked (me )?first|your fault|stop attack|why did you|playing (2|two) sides/i;
const HOSTILE_RE = /attack|destroy|kill|noob|crush|die\b|fuck|stupid/i;

// ---------------------------------------------------------------- CAMPAIGN
/** Where the owner-given plan stands: step 1 take a named province, step 2 make peace, step 3 press another player's cities. */
export function campaignStep(s: GameState, st: Settings, mem: Memory): { stage: 0 | 1 | 2 | 3; only: string; spare: Set<number>; focus: Set<number> } {
  const c = st.campaign;
  const none = { stage: 0 as const, only: "", spare: new Set<number>(), focus: new Set<number>() };
  if (!c || (!c.first && !c.peaceWith.length && !c.then.length)) return none;
  const key = JSON.stringify(c);
  if (mem.campaign.key !== key) mem.campaign = { key, startedAt: Date.now(), firstDone: false, peaceAt: 0 };
  const cm = mem.campaign, now = Date.now();
  const name = c.first.trim().toLowerCase();
  if (name && !cm.firstDone && (s.provinces.some((p) => p.name.trim().toLowerCase() === name) || now - cm.startedAt > 24 * 3600_000)) cm.firstDone = true; // taken (or given up after a day)
  if (name && !cm.firstDone) return { ...none, stage: 1, only: s.frontier.some((f) => f.name.trim().toLowerCase() === name) ? name : "", spare: new Set() };
  if (c.peaceWith.length && !cm.peaceAt) return { ...none, stage: 2, spare: new Set(c.peaceWith) }; // peace offers go out this tick
  return { stage: 3, only: "", spare: new Set(c.peaceWith), focus: new Set(c.then) };
}

/** Peace with the named players once the first goal is taken. Offers go out through the normal peace action; the owner is left alone meanwhile. */
export function planCampaign(s: GameState, st: Settings, mem: Memory): Decision[] {
  const camp = campaignStep(s, st, mem);
  const out: Decision[] = [];
  const now = Date.now();
  if (camp.stage === 2) {
    for (const pid of st.campaign.peaceWith) {
      const p = s.players.find((x) => x.id === pid);
      if (!p || (p.rel ?? -2) >= 1) continue;
      out.push({ kind: "relation", args: [pid, 1], label: `Offer peace to ${p.nation} (${p.name})`, reason: `campaign: ${st.campaign.first || "first goal"} is taken, now peace with ${p.nation}`, cost: {} });
      if (p.human && (mem.lastMessaged[pid] ?? 0) < now - 60 * 60_000) {
        const text = compose((mem.sentTexts[String(pid)] ?? []).length >= 1 ? "negotiate_again" : "negotiate", pid, mem) ?? compose("negotiate_again", pid, mem);
        if (text) { remember(mem, pid, text); out.push({ kind: "message", args: [pid, text], label: `Message ${p.nation} about peace`, reason: "campaign: peace after taking the province", cost: {} }); }
      }
      mem.lastPeaceOffer[pid] = now;
      mem.truce[pid] = now + 24 * 3600_000; // do not attack them while the offer stands
    }
    mem.campaign.peaceAt = now;
  }
  return out;
}

export function planDiplomacy(s: GameState, st: Settings, mem: Memory): Decision[] {
  const out: Decision[] = [];
  const now = Date.now();
  const targetOwners = new Set(findTargets(s, st, mem).map((t) => t.prov.owner));
  const neighbours = new Set(s.frontier.map((f) => f.owner));
  let n = 0;
  // Outgunned: a strong stack stands near my cities and I cannot answer it -> sue for peace with its owner and stand down against them.
  const asked = new Set<number>(); // one offer + one message per owner per tick, however many of my cities they threaten
  for (const th of assessThreats(s)) {
    if (th.threat < 8 || th.ratio < 2) continue;
    for (const oid of th.owners) {
      if (asked.has(oid)) continue;
      const p = s.players.find((x) => x.id === oid);
      if (!p || p.id === s.me.id || p.id === 0 || /insurg/i.test(p.nation) || isTeamOrAlly(s, p.id)) continue;
      if ((p.rel ?? -2) >= 1 || (mem.lastPeaceOffer[oid] ?? 0) > now - 6 * 3600_000) continue;
      out.push({ kind: "relation", args: [oid, 1], label: `Offer peace to ${p.nation} (${p.name}) - outgunned near ${th.name}`, reason: `their stack ${th.threat.toFixed(1)} vs my defence ${th.defence.toFixed(1)} at ${th.name}`, cost: {} });
      if (p.human && (mem.lastMessaged[oid] ?? 0) < now - 12 * 3600_000) {
        const text = compose("peace_threat", oid, mem);
        if (text) { remember(mem, oid, text); out.push({ kind: "message", args: [oid, text], label: `Message ${p.nation} about peace`, reason: "outgunned: ask for a truce", cost: {} }); }
      }
      mem.truce[oid] = now + 12 * 3600_000;
      asked.add(oid);
      n++;
    }
  }
  // Losing to a specific player: negotiate. They keep taking provinces back, so stop provoking them and offer peace in plain words.
  for (const [id, r] of Object.entries(mem.enemy)) {
    const oid = Number(id);
    if (asked.has(oid) || r.lossesTo < 2 || now - r.lastLoss > 12 * 3600_000 || r.stack < 8) continue;
    const p = s.players.find((x) => x.id === oid);
    if (!p || !p.human || p.id === s.me.id || isTeamOrAlly(s, oid)) continue;
    if ((p.rel ?? -2) >= 1 || (mem.lastPeaceOffer[oid] ?? 0) > now - 8 * 3600_000) continue;
    const text = compose((mem.sentTexts[String(oid)] ?? []).length >= 1 ? "negotiate_again" : "negotiate", oid, mem) ?? compose("negotiate_again", oid, mem);
    out.push({ kind: "relation", args: [oid, 1], label: `Offer peace to ${p.nation} (${p.name}) - losing to them`, reason: `they took ${r.lossesTo} of my provinces (biggest stack ${r.stack.toFixed(0)}); stop provoking, negotiate`, cost: {} });
    if (text && (mem.lastMessaged[oid] ?? 0) < now - 6 * 3600_000) { remember(mem, oid, text); out.push({ kind: "message", args: [oid, text], label: `Message ${p.nation} to negotiate peace`, reason: "losing to them: own the war and offer to stop", cost: {} }); }
    mem.truce[String(oid)] = now + 12 * 3600_000;
    asked.add(oid);
    n++;
  }
  for (const p of s.players) {
    if (n >= 2) break;
    if (asked.has(p.id)) continue; // already handled above (one offer per owner per tick)
    // only players that matter: direct neighbours, or anyone currently at war with us
    if (!neighbours.has(p.id) && p.rel !== -2) continue;
    if (p.id === s.me.id || p.id === 0 || !p.human) continue;
    if (targetOwners.has(p.id) || st.targetPlayers.includes(p.id)) continue;
    if (isTeamOrAlly(s, p.id)) continue;
    if ((p.rel ?? -2) >= 1) continue; // already at least peace
    if ((mem.lastPeaceOffer[p.id] ?? 0) > now - 24 * 3600_000) continue; // a proposal pops up on their screen: once a day is plenty
    out.push({ kind: "relation", args: [p.id, 1], label: `Offer peace to ${p.nation} (${p.name})`, reason: "fewer wars = better morale, safer borders", cost: {} });
    n++;
  }
  return out;
}

const INSULT_RE = /noob|fuck|stupid|idiot|trash|loser|die/i;

/**
 * Inbound mail from humans. Policy: answer only what has a clear, safe answer (hello, peace, trade, "join us"), flag questions,
 * accusations and threats for a human instead of faking a reply, ignore insults and plain statements, and never repeat myself.
 * No unprompted greetings: the bot speaks when it has something to say (coalition application, truce under threat).
 */
export function planMessages(s: GameState, st: Settings, mem: Memory, inbox: InboxMsg[]): Decision[] {
  const out: Decision[] = [];
  const now = Date.now();
  mem.sentMessagesLog = mem.sentMessagesLog.filter((t) => t > now - 3600_000);
  let budget = st.messageLimitPerHour - mem.sentMessagesLog.length;
  const byId = new Map(s.players.map((p) => [p.id, p]));
  const hasLLM = !!process.env.ANTHROPIC_API_KEY;

  const fresh = inbox.filter((m) => !m.mine && !m.read && !mem.seenInbox.includes(m.uid));
  const handled = new Set<number>();
  for (const m of [...fresh].reverse()) { // newest first: one answer per sender covers their older unread mail too
    const p = byId.get(m.from);
    mem.seenInbox.push(m.uid);
    if (!p || !p.human || handled.has(p.id)) continue;
    handled.add(p.id);
    for (const o of fresh) if (o.from === p.id) mem.seenInbox.push(o.uid);
    const body = m.body.trim();
    const label = (what: string) => `${what} ${p.name} (${p.nation})`;
    const flag = (why: string) => out.push({ kind: "message", args: [], label: `NEEDS A HUMAN: ${p.nation} (${p.name}) wrote "${body.slice(0, 90)}"`, reason: why, cost: {}, meta: { player: p.id, incoming: body } });

    const warmLead = p.team > 0 && (mem.lastMessaged[p.id] ?? 0) > now - 72 * 3600_000; // a coalition member answering my application
    if (warmLead) mem.coalitionWarm[String(p.team)] = now;

    let kind: MsgKind | null = null;
    let relation: number | null = null;
    if (INSULT_RE.test(body) && !QUESTION_RE.test(body)) continue; // do not feed it
    if (p.team > 0 && INVITE_RE.test(body) && !ACCUSE_RE.test(body)) { // a member of a coalition asks me to join: the planner takes it up, and I answer yes
      mem.coalitionInvite[String(p.team)] = now;
      if (budget > 0 && now - (mem.lastReplyAt[String(p.id)] ?? 0) > 6 * 3600_000) {
        const text = compose("accept_invite", p.id, mem);
        if (text) { remember(mem, p.id, text); mem.lastReplyAt[String(p.id)] = now; out.push({ kind: "message", args: [p.id, text], label: `${label("Reply to")}: "${body.slice(0, 40)}${body.length > 40 ? "..." : ""}"`, reason: "coalition invitation: accepting", cost: {}, meta: { player: p.id, incoming: body } }); budget--; }
      }
      continue;
    }
    if (ACCUSE_RE.test(body) || /(attack|destroy|kill)/i.test(body) && !PEACE_RE.test(body)) { if (!hasLLM) { flag("accusation or threat - not answered by a template"); continue; } }
    else if (PEACE_RE.test(body)) { kind = "reply_peace"; relation = 1; }
    else if (TRADE_RE.test(body) && !QUESTION_RE.test(body)) kind = "reply_trade";
    else if (ALLY_RE.test(body) && !warmLead) kind = "reply_ally";
    else if (isGreeting(body)) kind = warmLead ? null : "reply_hello";
    else if (QUESTION_RE.test(body)) { if (!hasLLM) { flag("a question - the bot will not guess an answer"); continue; } }
    else if (warmLead && now - (mem.lastReplyAt[String(p.id)] ?? 0) > 12 * 3600_000) kind = "thanks";
    if (!kind || budget <= 0) continue;
    if (kind === "reply_hello" && now - (mem.lastReplyAt[String(p.id)] ?? 0) < 12 * 3600_000) continue;

    const text = compose(kind, p.id, mem);
    if (!text) continue; // every variant already used on them: say nothing
    remember(mem, p.id, text);
    mem.lastReplyAt[String(p.id)] = now;
    out.push({ kind: "message", args: [p.id, text], label: `${label("Reply to")}: "${body.slice(0, 40)}${body.length > 40 ? "..." : ""}"`, reason: kind.replace("_", " "), cost: {}, meta: { player: p.id, incoming: body } });
    if (relation !== null && st.doDiplomacy) out.push({ kind: "relation", args: [p.id, relation], label: `Set peace with ${p.nation}`, reason: "they asked for peace", cost: {} });
    budget--;
  }
  return out;
}

// ---------------------------------------------------------------- MARKET
export interface MarketOrder { id: number; buy: boolean; amount: number; limit: number; res: number; player: number }
export interface MarketInfo { prices: Record<string, { price: number; min: number; max: number }>; asks: MarketOrder[]; bids: MarketOrder[]; mine: MarketOrder[] }

/** Keep scarce inputs stocked by buying with surplus money. One standing bid per resource; stale bids are cancelled and re-priced. */
export function planMarket(s: GameState, st: Settings, m: MarketInfo, mem: Memory, budget: Budget, short?: Shortfall): Decision[] {
  const out: Decision[] = [];
  const now = Date.now();
  const mk = st.market;
  const money = budget[R.MONEY] ?? 0;
  const moneyReserve = st.reserve[R.MONEY] ?? 0;
  const lacks = short ?? {};
  const moneyShort = (lacks[R.MONEY] ?? 0) > 0 || money < moneyReserve * mk.sellWhenMoneyBelow;
  let spendLeft = Math.max(0, Math.min(money - moneyReserve * 0.5, money * mk.maxSpendPct));

  const rids = Object.keys(m.prices).filter((r) => r !== R.MONEY);
  for (const rid of rids) {
    const info = m.prices[rid];
    const name = s.resources[rid]?.name ?? rid;
    const have = budget[rid] ?? 0;
    const perHour = s.resources[rid]?.perHour ?? 0;

    // 1. Manage my standing order for this resource (one at a time, either side).
    const mine = m.mine.find((o) => String(o.res) === rid);
    if (mine) {
      const age = now - (mem.orderPlacedAt[rid] ?? now);
      // a bid that is holding up a wanted build is repriced sooner than an idle one
      const staleAfter = mine.buy && (lacks[rid] ?? 0) > 0 ? Math.min(mk.staleHours, 1) : mk.staleHours;
      if (age > staleAfter * 3600_000) {
        out.push({ kind: "cancel_order", args: [mine.id], label: `Cancel stale ${mine.buy ? "bid" : "offer"} for ${name}`, reason: `open ${(age / 3600_000).toFixed(1)}h without filling; will re-price`, cost: {}, meta: { resource: Number(rid), side: mine.buy ? "buy" : "sell" } });
      }
      continue;
    }

    // 2. BUY what is blocking a wanted build / research / unit, plus hard floors on scarce inputs.
    const blockedBy = lacks[rid] ?? 0;
    const buyOff = (mem.blocked["market:buy:" + rid] ?? 0) > now, sellOff = (mem.blocked["market:sell:" + rid] ?? 0) > now; // the server refused my last such order
    const floor = mk.stock[rid] ?? 0;
    // Size the order for the first (highest priority) waiting item that lacks this resource, not for the biggest shortfall of everything waiting:
    // a build that lacks 44 Supplies must not be held up by a 1,000-Supplies research bid at a poor price (one standing order per resource).
    const first = waitingOf(short).find((w) => (w.lacks[rid] ?? 0) > 0);
    const needNow = first ? first.lacks[rid] : blockedBy;
    const wantBuy = Math.max(needNow * 1.15, have < floor * 0.6 ? floor - have : 0);
    // Buying is only off the table when money itself is what blocks the wanted item; being below the "sell" comfort level must not stop me buying a missing input.
    const moneyBlocks = (lacks[R.MONEY] ?? 0) > 0;
    if (!buyOff && wantBuy >= 20 && (!moneyBlocks || have < floor * 0.6) && spendLeft > 0) {
      // the quoted price can sit below the allowed minimum (stale quote); the minimum is then the real price, so the cap must never be lower than it
      const cap = Math.min(info.max, Math.max(Math.ceil(info.price * mk.maxPriceMult), Math.ceil(info.min)));
      const asks = m.asks.filter((o) => String(o.res) === rid && Math.ceil(o.limit) <= cap && o.player !== s.me.id).sort((a, c) => a.limit - c.limit);
      // a limit outside the resource's allowed price band is refused by the server
      const limit = Math.max(Math.ceil(info.min), Math.min(cap, asks.length ? Math.ceil(asks[0].limit) : Math.ceil(Math.max(info.min, info.price)) + (mem.bidBump[rid] ?? 0)));
      // never panic-buy: above 2.5x the resource's floor price the buying itself is what drives the price up, and the money is needed for defenders
      const amount = limit > Math.min(info.max, cap) || limit > Math.floor(info.min * 2.5) ? 0 : Math.floor(Math.min(wantBuy, spendLeft / limit));
      if (amount >= 20) {
        spendLeft -= amount * limit;
        budget[R.MONEY] = (budget[R.MONEY] ?? 0) - amount * limit;
        out.push({ kind: "market", args: [true, amount, limit, Number(rid)], label: `Buy ${amount} ${name} @ ${limit}`, reason: blockedBy > 0 ? `short ${Math.ceil(blockedBy)} for a wanted build/research/unit` : `stock ${Math.round(have)} below floor ${floor}`, cost: { [R.MONEY]: amount * limit }, meta: { resource: Number(rid), side: "buy" } });
        continue;
      }
    }

    // 3. SELL idle surplus: stock that no wanted item needs, above my keep level, when money is the bottleneck.
    if (!mk.sell || sellOff || blockedBy > 0 || perHour < 0) continue;
    const keep = Math.max(mk.keep[rid] ?? 0, (st.reserve[rid] ?? 0) * 1.5);
    const surplus = have - keep;
    if (surplus < 150) continue;
    if (!moneyShort && surplus < keep * 2) continue; // money is fine: only dump a truly huge pile
    const bids = m.bids.filter((o) => String(o.res) === rid && o.player !== s.me.id && o.limit >= info.min).sort((a, c) => c.limit - a.limit);
    const best = bids[0];
    const limit = best ? Math.floor(best.limit) : Math.floor(Math.max(info.min, info.price));
    if (limit < info.min) continue;
    const amount = Math.floor(Math.min(surplus, best ? best.amount : surplus / 2));
    if (amount < 100) continue;
    budget[rid] = have - amount;
    out.push({ kind: "market", args: [false, amount, limit, Number(rid)], label: `Sell ${amount} ${name} @ ${limit}`, reason: `idle surplus: ${Math.round(have)} held vs keep ${Math.round(keep)}; funds the economy (+${amount * limit} money)`, cost: {}, meta: { resource: Number(rid), side: "sell" } });
  }
  return out;
}

// ---------------------------------------------------------------- COALITION
export interface CoalitionInfo { mine: number | null; list: { id: number; name: string; members: number; score: number; req: number; leader: number; pending: boolean }[] }
const PENDING_HOURS = 18;

/**
 * A coalition shares one victory limit (a 5-member coalition needs 5920 VP in total vs 1850 solo, i.e. ~1184 each),
 * and members get right of way. Solo play at ~2 VP/h will never reach 1850, so join the strongest coalition that will take us.
 * One application at a time; unanswered ones are withdrawn after PENDING_HOURS and the next candidate is tried.
 */
export function planCoalition(s: GameState, st: Settings, co: CoalitionInfo, mem: Memory): Decision[] {
  if (!st.doCoalition || co.mine !== null) return [];
  const now = Date.now();
  const pending = co.list.find((c) => c.pending);
  const warm = (c: { id: number }) => now - (mem.coalitionWarm[String(c.id)] ?? 0) < 48 * 3600_000;
  const invited = (c: { id: number }) => now - (mem.coalitionInvite[String(c.id)] ?? 0) < 24 * 3600_000;
  if (pending) {
    const age = now - (mem.coalitionTried[String(pending.id)] ?? now);
    // A coalition whose member answered kindly beats one that has been silent: switch (one application at a time).
    const usable = (c: { id: number }) => (mem.blocked["coalition:" + c.id] ?? 0) < now; // the server refused my last application to it: do not give up a working one for it
    const invite = co.list.find((c) => c.id !== pending.id && invited(c) && !c.pending && usable(c));
    if (invite && !invited(pending) && age > 30 * 60_000) return [{ kind: "coalition_withdraw", args: [pending.id], label: `Withdraw application to ${pending.name}`, reason: `${invite.name} invited me to join; taking the invitation instead of waiting`, cost: {} }];
    const lead = co.list.find((c) => c.id !== pending.id && usable(c) && warm(c) && now - (mem.coalitionTried[String(c.id)] ?? 0) > 72 * 3600_000);
    if (lead && !warm(pending) && age > 30 * 60_000) return [{ kind: "coalition_withdraw", args: [pending.id], label: `Withdraw application to ${pending.name}`, reason: `${lead.name} answered my message kindly - switching to the warmer lead`, cost: {} }];
    if (age > PENDING_HOURS * 3600_000) return [{ kind: "coalition_withdraw", args: [pending.id], label: `Withdraw application to ${pending.name}`, reason: `unanswered for ${(age / 3600_000).toFixed(0)}h; trying the next coalition`, cost: {} }];
    return [];
  }
  // The client's pending flag lags behind the server, so also trust my own record: never apply twice within the waiting window.
  if (co.list.some((c) => now - (mem.coalitionTried[String(c.id)] ?? 0) < 10 * 60_000)) return [];
  const warred = new Set(Object.keys(mem.warDeclaredAt).map(Number));
  const frontierOwners = new Set(s.frontier.map((p) => p.owner));
  const cands = co.list
    .filter((c) => now - (mem.coalitionTried[String(c.id)] ?? 0) > 72 * 3600_000)
    .filter((c) => (mem.blocked["coalition:" + c.id] ?? 0) < now) // my last application to it was refused: wait
    .filter((c) => c.members >= 2 || invited(c)) // a lone leader is as inactive-prone as me; real teams first (unless they invited me)
    .map((c) => {
      const members = s.players.filter((p) => p.team === c.id);
      const hostile = members.some((p) => warred.has(p.id) || p.rel === -2);
      const borders = members.filter((p) => frontierOwners.has(p.id)).length;
      const progress = (c.score + s.me.vps) / Math.max(1, c.req);
      return { c, hostile: hostile && !invited(c), score: progress * (1 - 0.2 * borders) * (c.members >= 3 ? 1.1 : 1) * (warm(c) ? 3 : 1) * (invited(c) ? 10 : 1) };
    })
    .filter((x) => !x.hostile)
    .sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (!best) return [];
  const out: Decision[] = [{ kind: "coalition_apply", args: [best.c.id], label: `Apply to coalition ${best.c.name}`, reason: `${best.c.members} members, ${best.c.score}/${best.c.req} VP (${(best.score * 100).toFixed(1)}% progress incl. mine)`, cost: {} }];
  if (best.c.leader && best.c.leader !== s.me.id && now - (mem.lastMessaged[best.c.leader] ?? 0) > 72 * 3600_000) {
    const text = compose("apply", best.c.leader, mem, { coalition: best.c.name, me: s.me.nation.toLowerCase() });
    if (text) { remember(mem, best.c.leader, text); out.push({ kind: "message", args: [best.c.leader, text], label: `Message ${best.c.name} leader about my application`, reason: "introduce the application", cost: {} }); }
  }
  return out;
}

// ---------------------------------------------------------------- THREATS & DEFENCE
export interface Threat { id: number; name: string; threat: number; defence: number; owners: number[]; ratio: number }

/** For each of my cities/capital: strength of non-allied armies within striking distance vs. my defence there. */
/** The capital is threatened by a stack far stronger than what defends it. */
export function capitalInDanger(s: GameState): boolean {
  return assessThreats(s).some((t) => t.id === s.me.capital && t.threat >= 8 && t.ratio >= 2);
}

export function assessThreats(s: GameState): Threat[] {
  const out: Threat[] = [];
  for (const p of s.provinces) {
    if (!(p.city || p.id === s.me.capital)) continue;
    const near = s.otherArmies.filter((a) => !isTeamOrAlly(s, a.owner) && dist(a.x, a.y, p.x, p.y) < 170);
    if (!near.length) continue;
    const threat = near.reduce((x, a) => x + a.str, 0);
    const defence = s.armies.filter((a) => dist(a.x, a.y, p.x, p.y) < 120).reduce((x, a) => x + a.def, 0);
    out.push({ id: p.id, name: p.name, threat, defence, owners: [...new Set(near.map((a) => a.owner))], ratio: threat / Math.max(0.1, defence) });
  }
  return out.sort((a, c) => c.ratio - a.ratio);
}

/**
 * Pull armies together toward a threatened city. A trickle of single armies loses to one big stack, so send enough helpers
 * (nearest first) that their combined defence beats the threat, not just one. Armies mid-march on an old order are usable;
 * armies the bot sent out within the last hour, and armies in combat, are left alone.
 */
export function planDefense(s: GameState, st: Settings, mem?: Memory): Decision[] {
  const out: Decision[] = [];
  const used = new Set<string | number>();
  const now = Date.now();
  const recentlyOrdered = (a: Army) => { const x = mem?.assigned[String(a.id)]; return !!x && now - x.t < 3600_000; };
  for (const th of assessThreats(s)) {
    if (out.length >= 8) break;
    if (th.threat <= Math.max(3, th.defence * 1.2)) continue; // ignore tiny / damaged units
    const prov = s.provinces.find((p) => p.id === th.id)!;
    const helpers = s.armies
      .filter((a) => !a.air && !a.sea && !a.fight && !used.has(a.id) && dist(a.x, a.y, prov.x, prov.y) > 60 && (mem ? !recentlyOrdered(a) : !a.moving))
      .sort((a, c) => dist(a.x, a.y, prov.x, prov.y) - dist(c.x, c.y, prov.x, prov.y));
    let need = th.threat * 1.2 - th.defence, sent = 0;
    for (const a of helpers) {
      if (need <= 0 || sent >= 4) break;
      used.add(a.id); need -= a.def; sent++;
      out.push({ kind: "move", args: [a.id, prov.x, prov.y], label: "Reinforce " + th.name + " with " + (a.name || a.id), reason: "threat " + th.threat.toFixed(1) + " vs defence " + th.defence.toFixed(1) + (sent > 1 ? " (concentrating)" : ""), cost: {}, meta: { role: "defence", aim: th.id } });
    }
    if (!sent) out.push({ kind: "move", args: [], label: "ALERT: " + th.name + " threatened (" + th.threat.toFixed(1) + " vs " + th.defence.toFixed(1) + ") and no spare army", reason: "enemy owners " + th.owners.join(","), cost: {} });
  }
  return out;
}

// ---------------------------------------------------------------- AUTO MODE
export function chooseMode(s: GameState, st: Settings, mem: Memory): Settings["mode"] {
  const units = s.armies.reduce((a, x) => a + x.units.length, 0);
  const money = s.resources[R.MONEY]?.amount ?? 0;
  const threatened = assessThreats(s).some((t) => t.threat >= 3 && t.ratio > 1);
  const targets = findTargets(s, st, mem);
  const strength = s.armies.filter((a) => !a.air && !a.sea).reduce((x, a) => x + a.str, 0);
  const best = targets[0];
  // A clearly beatable AI target is worth pressing even on day 1: early conquests snowball.
  const aiTarget = best && s.players.find((p) => p.id === best.prov.owner && !p.human);
  if (aiTarget && strength >= st.attackRatio.balanced * 1.5 * best.estDef && !threatened) return "balanced";
  if (s.day <= 1 || units < 10) return "economy";
  if (threatened) return "balanced";
  if (best && units >= 25 && money > 12000 && strength >= 2.5 * best.estDef) return "aggressive";
  return "balanced";
}
