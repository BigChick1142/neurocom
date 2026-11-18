// The persistent bot loop: perceive -> plan -> execute (whitelisted) -> log. Emits events for the dashboard.
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Frame } from "playwright";
import type { Session } from "../browser.js";
import { call, inject } from "../inject.js";
import { draftReply } from "./llm.js";
import { evaluateAttacks, tuneFromAttacks, tuneUnitCap } from "./tuner.js";
import { kb } from "./knowledge.js";
import { planCampaign, roleOf, waitingOf, type Waiting, findTargets, assessThreats, chooseMode, planDefense, budgetOf, planMarket, type MarketInfo, type Shortfall, type CoalitionInfo, planCoalition, planBuilds, planDiplomacy, planMessages, planMilitary, planTruceHalts, planRally, planAirSea, planMobilize, capitalInDanger, planResearch, type InboxMsg, type ProvOptions, type ResearchOpt } from "./brain.js";
import { loadSettings, patchSettings, saveSettings } from "./settings.js";
import { freshLab, type Decision, type GameState, type Memory, type Settings } from "./types.js";
import { dumpRules } from "../dumpmod.js";
import { reloadRules, rulesPresent } from "./rules.js";
import { labPlan, trackLab, type LabPlan } from "./lab.js";
import { buildIntel, lossLesson, trackActivity, updateEnemyRecords, type PlayerIntel, type RawIntel } from "./intel.js";

export interface LogEntry { t: number; level: "info" | "ok" | "warn" | "error"; kind: string; text: string; reason?: string; source: "bot" | "manual" | "system" }
export interface HistoryPoint { t: number; vp: number; provinces: number; units: number; money: number; day: number }

// Hard whitelist: the only page functions the bot may ever invoke for actions.
const ACTION_FN: Record<Decision["kind"], string> = {
  research: "startResearch", build: "build", mobilize: "mobilize", move: "moveArmy", relation: "setRelation", message: "sendMessage",
  market: "placeOrder", cancel_order: "cancelOrder", coalition_apply: "applyCoalition", coalition_withdraw: "withdrawCoalition",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadMemory(dir: string): Memory {
  const MEM_FILE = `${dir}/memory.json`;
  const fresh: Memory = { campaign: { key: "", startedAt: 0, firstDone: false, peaceAt: 0 }, coalitionInvite: {}, lastSent: {}, peaceOpen: {}, coalitionOpen: null, lastMessaged: {}, lastPeaceOffer: {}, warDeclaredAt: {}, capturedAt: {}, ownedLast: [], seenInbox: [], sentMessagesLog: [], failedTargets: {}, orderPlacedAt: {}, bidBump: {}, attacks: [], lastTune: 0, assigned: {}, blocked: {}, noEffect: {}, coalitionTried: {}, coalitionWarm: {}, truce: {}, moveTries: {}, needsHuman: [], sentTexts: {}, lastReplyAt: {}, enemy: {}, lessons: [], activity: {}, lab: freshLab() };
  try { if (existsSync(MEM_FILE)) return { ...fresh, ...JSON.parse(readFileSync(MEM_FILE, "utf8")) }; } catch { /* start fresh */ }
  return fresh;
}
function saveMemory(m: Memory, dir: string) { try { mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}/memory.json`, JSON.stringify(m)); } catch { /* ignore */ } }

export class Bot extends EventEmitter {
  readonly gameId: string;
  readonly dataDir: string;
  settings: Settings;
  mem: Memory;
  logs: LogEntry[] = [];
  history: HistoryPoint[]; // survives restarts (charts)
  constructor(opts: { gameId: string; dataDir: string }) {
    super();
    this.gameId = opts.gameId;
    this.dataDir = opts.dataDir;
    const brandNew = !existsSync(`${this.dataDir}/settings.json`);
    this.settings = loadSettings(this.dataDir);
    if (brandNew && this.settings.useKnowledge) {
      const seed = kb.seedParams(); // earlier games settled these risk knobs: start from them instead of the generic defaults
      if (seed) this.settings = { ...this.settings, attackRatio: { ...this.settings.attackRatio, ...seed.attackRatio }, maxUnits: { ...this.settings.maxUnits, ...Object.fromEntries(Object.entries(seed.maxUnits).map(([k, v]) => [k, Math.round(v)])) } };
    }
    kb.seenGame(this.gameId);
    this.mem = loadMemory(this.dataDir);
    this.history = (() => {
      try {
        const f = `${this.dataDir}/history.jsonl`;
        if (!existsSync(f)) return [];
        return readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).slice(-1500).map((l) => JSON.parse(l) as HistoryPoint).filter((p) => p.t > 1794831154000);
      } catch { return []; }
    })();
  }
  state: GameState | null = null;
  lastPlan: Decision[] = [];
  effectiveMode: Settings["mode"] = "balanced";
  lastMarket: MarketInfo | null = null;
  lastShortfall: Shortfall = {};
  lastWaiting: Waiting[] = [];
  lastLab: LabPlan | null = null;
  intel: Record<number, PlayerIntel> = {};
  private intelAt = 0;
  lastOpportunity = false;
  modeSince = 0;
  lastEmergency = false;
  lastInbox: InboxMsg[] = [];
  private prevState: GameState | null = null;
  private emergencyUntil = 0;
  private rawIntel: RawIntel | null = null;
  private idleHours: Record<number, number> = {};
  lastCoalitions: CoalitionInfo | null = null;
  counters = { ticks: 0, actions: 0, failures: 0, serverOk: 0, serverRefused: 0, startedAt: Date.now() };
  connected = false;
  private session: Session | null = null;
  private lastHistoryT = 0;
  private running = false;
  private firstTick = true;
  private busy = false;
  private injectedOnce = false;
  private rulesChecked = false;
  private pending: { key: string; kind: "build" | "mobilize"; pid: number; uid: number; before: number; label: string }[] = [];
  private lastServerTs = 0;
  private lastServerTsChange = Date.now();

  private holdLogged = new Map<string, number>();

  log(level: LogEntry["level"], kind: string, text: string, source: LogEntry["source"] = "system", reason?: string) {
    const e: LogEntry = { t: Date.now(), level, kind, text, reason, source };
    this.logs.push(e);
    if (this.logs.length > 400) this.logs.shift();
    try {
      mkdirSync(this.dataDir, { recursive: true });
      appendFileSync(`${this.dataDir}/activity.jsonl`, JSON.stringify(e) + "\n");
      appendFileSync("data/activity.jsonl", JSON.stringify({ ...e, game: this.gameId }) + "\n"); // combined log of every game (used by the health checks)
    } catch { /* ignore */ }
    this.emit("log", e);
    console.log(`[${new Date(e.t).toLocaleTimeString()}] [game ${this.gameId}] ${level.toUpperCase()} ${kind}: ${text}${reason ? "  (" + reason + ")" : ""}`);
  }

  updateSettings(patch: Record<string, unknown>) {
    this.settings = patchSettings(this.settings, patch);
    saveSettings(this.settings, this.dataDir);
    this.log("info", "settings", `Settings updated: ${Object.keys(patch).join(", ")}`, "manual");
    this.emit("update");
  }

  private frame(): Frame | undefined { return this.session?.frame(); }

  async start(session: Session) {
    this.running = true;
    this.log("info", "boot", `Attached to game ${this.gameId}`);
    this.session = session;
    this.tapServerResults();
    while (this.running) {
      const t0 = Date.now();
      try {
        await this.ensureReady();
        await this.tick();
      } catch (e) {
        this.connected = false;
        this.log("error", "tick", `Tick failed: ${(e as Error).message.split("\n")[0]}`);
        console.error((e as Error).stack?.split("\n").slice(0, 6).join("\n"));
        await sleep(5000);
      }
      this.emit("update");
      await sleep(Math.max(1000, this.settings.tickSeconds * 1000 - (Date.now() - t0)));
    }
  }

  stop() { this.running = false; }

  /** Watch every game-server response and report the server verdict (actionResults) for each action we sent. */
  private tapServerResults() {
    this.session!.page.on("response", async (res) => {
      try {
        const req = res.request();
        if (req.method() !== "POST" || !req.url().includes(".c.bytro.com")) return;
        const post = req.postData();
        if (!post || !post.includes("UltUpdateGameStateAction") || !post.includes("actionReq-")) return;
        const q = JSON.parse(post);
        const sent: { id: string; cls: string }[] = (q.actions?.[1] ?? []).map((a: any) => ({ id: a.requestID, cls: String(a["@c"]).split(".").pop() }));
        const j = JSON.parse(await res.text());
        const results = j?.result?.actionResults ?? {};
        for (const { id, cls } of sent) {
          const code = results[id];
          if (code === undefined) continue;
          if (code === 1) { this.counters.serverOk++; continue; }
          this.counters.serverRefused++;
          this.log("warn", "server", `Server refused ${cls} (code ${code})`, "system");
        }
      } catch { /* ignore non-JSON */ }
    });
  }

  private async ensureReady() {
    let f = this.frame();
    if (!f) throw new Error("this tab no longer shows the game"); // the manager stops this player when the tab leaves the game
    const ok = await f.evaluate("!!(window.__bot && window.__bot.ready && window.__bot.ready())").catch(() => false);
    if (!ok || !this.injectedOnce) {
      await inject(f);
      this.injectedOnce = true;
      this.connected = true;
      this.log("ok", "boot", "Connected to game and installed bot API");
    }
    this.connected = true;
    // First run: read the game's own rules (units, buildings, research) instead of shipping them with the project.
    if (!this.rulesChecked) {
      this.rulesChecked = true;
      if (!rulesPresent()) {
        this.log("info", "setup", "First run: reading the game's rules (units, buildings, research). This takes about a minute.");
        try {
          await dumpRules(f);
          reloadRules();
          this.log("ok", "setup", "Game rules saved. Estimates for build times, unit costs and ranges are now exact.");
        } catch (e) {
          this.log("warn", "setup", `Could not read the game rules yet (${(e as Error).message.split("\n")[0]}). The bot works with rough estimates and tries again next start.`);
        }
      }
    }
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const game = this.frame()!;
      const s = (await call<GameState>(game, "state"));
      this.state = s;
      this.counters.ticks++;
      // Watchdog: the game polls its server constantly; if its state timestamp stops moving the session is stale.
      if (s.serverTs && s.serverTs !== this.lastServerTs) { this.lastServerTs = s.serverTs; this.lastServerTsChange = Date.now(); }
      else if (Date.now() - this.lastServerTsChange > 12 * 60_000) {
        this.log("warn", "watchdog", "Game state has not updated for 12 minutes - reloading the page", "system");
        this.lastServerTsChange = Date.now();
        this.injectedOnce = false;
        await this.session!.reload();
        return;
      }
      const lost = this.trackChanges(s);
      if (lost.length) await this.learnFromLosses(game, s, lost);
      this.prevState = s; // next tick compares against this (used to explain a loss)
      trackLab(s, this.mem.lab, Date.now(), (k, n, a, c) => kb.recordUnit(k, n, a, c));
      updateEnemyRecords(s, this.mem.enemy);
      this.idleHours = trackActivity(s.otherArmies.filter((a) => !a.removed), Object.fromEntries(s.players.map((p) => [p.id, p.vps])), this.mem.activity);
      this.verifyPending(s);
      this.trackKnowledge(s);
      this.runTuner(s);
      this.sampleHistory(s);

      if (this.firstTick) {
        const inbox = await call<InboxMsg[]>(game, "inbox").catch(() => []);
        for (const m of inbox) this.mem.seenInbox.push(m.uid); // never reply to old mail
        this.firstTick = false;
        this.log("info", "boot", `Playing as ${s.me.nation} (${s.me.name}), day ${s.day}, ${s.provinces.length} provinces, ${s.armies.length} armies`);
      }

      if (!this.settings.enabled) { this.lastPlan = []; return; }
      const plan = await this.plan(game, s);
      this.lastPlan = plan;
      await this.execute(game, plan, "bot");
      saveMemory(this.mem, this.dataDir);
    } finally {
      this.busy = false;
    }
  }

  /** Close the loop on things I started earlier: did the peace offer get accepted, did the coalition take me? */
  private trackKnowledge(s: GameState) {
    const now = Date.now();
    for (const [pid, o] of Object.entries(this.mem.peaceOpen)) {
      const p = s.players.find((x) => x.id === Number(pid));
      if (p && (p.rel ?? -2) >= 1) { kb.recordPeace(o.kind, true); delete this.mem.peaceOpen[pid]; }
      else if (now - o.t > 12 * 3600_000) { kb.recordPeace(o.kind, false); delete this.mem.peaceOpen[pid]; }
    }
    const co = this.mem.coalitionOpen;
    if (co && this.lastCoalitions) {
      if (this.lastCoalitions.mine === co.id) { kb.recordCoalition(co.size, "joined", (now - co.t) / 3600_000); this.mem.coalitionOpen = null; }
      else if (now - co.t > 20 * 3600_000) this.mem.coalitionOpen = null; // never answered
    }
  }

  /** Did last tick's builds / mobilizations actually change anything? Repeated silent no-ops get blocked. */
  private verifyPending(s: GameState) {
    const now = Date.now();
    for (const p of this.pending) {
      const prov = s.provinces.find((x) => x.id === p.pid);
      const effective = !!prov && (p.kind === "build"
        ? (prov.constructing ?? 0) > p.before || !!prov.have?.includes(p.uid)
        : (prov.producing ?? 0) > p.before);
      if (effective) { this.mem.noEffect[p.key] = 0; continue; }
      const n = (this.mem.noEffect[p.key] ?? 0) + 1;
      this.mem.noEffect[p.key] = n;
      if (n >= 2) {
        this.mem.blocked[p.key] = now + 12 * 3600_000;
        this.mem.noEffect[p.key] = 0;
        this.log("warn", "no-effect", p.label + " had no effect twice - blocking for 12h", "system");
      }
    }
    this.pending = [];
  }

  /** Learn from outcomes: judge past attacks, then nudge risk knobs. Applies at most hourly for the unit cap. */
  private runTuner(s: GameState) {
    const now = Date.now();
    const { done, keep } = evaluateAttacks(s, this.mem.attacks, now);
    this.mem.attacks = keep;
    const patches: Partial<Settings>[] = [];
    for (const d of done) { const at = (this.mem.lab.attacks ??= { won: 0, failed: 0 }); if (d.result === "success") at.won++; else at.failed++; }
    for (const d of done) if (d.rec.ratio !== undefined) kb.recordBattle(d.rec.human ? "human" : "ai", d.rec.ratio, d.result === "success");
    if (done.length) {
      const r = tuneFromAttacks(this.settings, done);
      for (const n of r.notes) this.log("info", "tuner", n, "system");
      patches.push(r.patch);
      this.settings = { ...this.settings, ...r.patch };
    }
    if (now - this.mem.lastTune > 3600_000) {
      this.mem.lastTune = now;
      kb.recordParams(this.settings.attackRatio, this.settings.maxUnits);
      const r = tuneUnitCap(s, this.settings, this.effectiveMode);
      for (const n of r.notes) this.log("info", "tuner", n, "system");
      if (Object.keys(r.patch).length) this.settings = { ...this.settings, ...r.patch };
      patches.push(r.patch);
    }
    if (patches.some((p) => Object.keys(p).length)) saveSettings(this.settings, this.dataDir);
  }

  /** Logs conquests; returns the ids of provinces I lost since the last tick. */
  private trackChanges(s: GameState): number[] {
    const now = Date.now();
    const cur = s.provinces.map((p) => p.id);
    const lost: number[] = [];
    if (this.mem.ownedLast.length) {
      const before = new Set(this.mem.ownedLast);
      const nowSet = new Set(cur);
      for (const id of cur) if (!before.has(id)) {
        this.mem.capturedAt[id] = now;
        this.log("ok", "conquest", `Gained province ${s.provinces.find((p) => p.id === id)?.name ?? id}`);
      }
      for (const id of before) if (!nowSet.has(id)) lost.push(id);
    }
    this.mem.ownedLast = cur;
    return lost;
  }

  /** Ask the game who took each lost province, then record what the bot learns from it. */
  private async learnFromLosses(game: Frame, s: GameState, lost: number[]) {
    const now = Date.now();
    for (const id of lost) {
      const info = await call<{ name: string; owner: number; x?: number; y?: number } | null>(game, "provinceOwner", id).catch(() => null);
      const text = lossLesson(s, this.mem.enemy, info?.name ?? String(id), info?.owner, now, { prev: this.prevState, x: info?.x, y: info?.y });
      this.log("warn", "loss", text.split(" Lesson:")[0]);
      kb.recordLoss(text.includes("Nothing was defending"));
      const lesson = text.slice(text.indexOf("Lesson:"));
      const last = this.mem.lessons[this.mem.lessons.length - 1];
      const repeat = last && now - last.t < 3 * 3600_000 && last.text.slice(last.text.indexOf("Lesson:")).slice(0, 70) === lesson.slice(0, 70);
      if (text.includes("Lesson:") && !repeat) {
        this.mem.lessons.push({ t: now, text });
        kb.addLesson(text);
        if (this.mem.lessons.length > 30) this.mem.lessons.shift();
        this.log("info", "lesson", text.slice(text.indexOf("Lesson:")), "bot");
      }
    }
  }

  private sampleHistory(s: GameState) {
    const now = Date.now();
    if (now - this.lastHistoryT < 5 * 60_000 && this.history.length) return;
    this.lastHistoryT = now;
    kb.recordPace(s.day, s.me.vps, s.provinces.length, s.armies.reduce((a, x) => a + x.units.length, 0), s.resources["20"]?.amount ?? 0);
    const pt: HistoryPoint = { t: now, vp: s.me.vps, provinces: s.provinces.length, units: s.armies.reduce((a, x) => a + x.units.length, 0), money: Math.round(s.resources["20"]?.amount ?? 0), day: s.day };
    this.history.push(pt);
    if (this.history.length > 2000) this.history.shift();
    try { appendFileSync(`${this.dataDir}/history.jsonl`, JSON.stringify(pt) + "\n"); } catch { /* ignore */ }
  }

  /** Build the decision list for this tick. */
  private async plan(game: Frame, s: GameState): Promise<Decision[]> {
    let st = this.settings;
    if (st.autoMode) {
      let m = chooseMode(s, st, this.mem);
      // Threat and target sightings flicker as stacks move in and out of view: hold a mode for 15 minutes unless the capital is in danger.
      if (m !== this.effectiveMode && this.modeSince && Date.now() - this.modeSince < 15 * 60_000 && !capitalInDanger(s)) m = this.effectiveMode;
      if (m !== this.effectiveMode) { this.log("info", "mode", "Auto mode: " + this.effectiveMode + " -> " + m, "bot"); this.modeSince = Date.now(); }
      this.effectiveMode = m;
      st = { ...st, mode: m };
    } else {
      this.effectiveMode = st.mode;
    }
    for (const [id, t] of Object.entries(this.mem.capturedAt)) if (Date.now() - t < 4 * 3600_000) this.mem.blocked["prov:" + id] = t + 4 * 3600_000;
    // Clear war-confirmation pop-ups left by attack orders the game wanted a human to confirm (only while such orders are pending).
    if (Object.values(this.mem.moveTries).some((m) => Date.now() - m.t < 5 * 60_000)) await call<number>(game, "dismissWarDialogs").catch(() => 0);
    const budget = budgetOf(s);
    const short: Shortfall = {};
    // newspaper + player profiles every ~8 min (cheap read-only); observed idleness is refreshed every tick
    if (Date.now() - this.intelAt > 8 * 60_000) {
      this.intelAt = Date.now();
      const raw = await call<RawIntel>(game, "intel").catch(() => null);
      if (raw) { this.rawIntel = raw; }
    }
    if (this.rawIntel) this.intel = buildIntel(this.rawIntel, Date.now(), this.idleHours);
    const noLandTargets = findTargets(s, st, this.mem, this.intel).length === 0 && s.day >= 2;
    const lab = labPlan(this.mem.lab, { mode: st.mode, noLandTargets, coastalFrontier: false });
    this.lastLab = lab;
    const plan: Decision[] = [];

    const byValue = (a: { city: boolean; vp: number }, b: { city: boolean; vp: number }) => Number(b.city) - Number(a.city) || b.vp - a.vp;
    const needUp = st.doBuild ? s.provinces.filter((p) => p.freeSlot).sort(byValue).map((p) => p.id) : [];
    const needProd = st.doMobilize ? s.provinces.filter((p) => p.canMob && (p.producing ?? 0) < (p.prodSlots ?? 1)).sort(byValue).map((p) => p.id) : [];
    const options = new Map<number, ProvOptions>();
    const batch = async (ids: number[], up: boolean, prod: boolean) => {
      if (!ids.length) return;
      const rows = await call<({ id: number } & ProvOptions)[]>(game, "options", ids.slice(0, 24), up, prod);
      for (const r of rows) { const o = options.get(r.id) ?? { upgrades: [], productions: [] }; options.set(r.id, { upgrades: [...o.upgrades, ...r.upgrades], productions: [...o.productions, ...r.productions] }); }
    };
    await batch(needUp, true, false);
    await batch(needProd, false, true);

    const research = async () => {
      if (st.doResearch && !emergency && s.research.freeSlots > 0) { // war footing: money goes to defenders, not research
        const opts = await call<ResearchOpt[]>(game, "possibleResearch");
        const noLand = findTargets(s, st, this.mem, this.intel).length === 0 && s.day >= 2;
        plan.push(...planResearch(s, st, opts, budget, noLand, short, lab));
      }
    };
    // Economy buildings get first call on scarce resources (rare materials!), then research, then units.
    // Opportunity: a weak, reachable owner (crippled / idle / unstable) is worth building the army for NOW, before more economy.
    const opportunity = st.mode !== "economy" && findTargets(s, st, this.mem, this.intel).some((t) => (this.intel[t.prov.owner]?.weakness ?? 0) >= 0.8);
    // hysteresis: an enemy stack flickers in and out of view, so stay on a war footing for 20 min after the last sighting
    if (capitalInDanger(s)) this.emergencyUntil = Date.now() + 20 * 60_000;
    const emergency = Date.now() < this.emergencyUntil;
    if (emergency !== this.lastEmergency) {
      this.lastEmergency = emergency;
      this.log(emergency ? "warn" : "info", "emergency", emergency ? "Capital threatened by a much stronger stack - war footing: units first, economy builds paused, reserves relaxed" : "Capital no longer in danger - back to normal", "bot");
    }
    if (opportunity !== this.lastOpportunity) {
      this.lastOpportunity = opportunity;
      this.log("info", "opportunity", opportunity ? "Weak reachable target in range - building the army before more economy" : "No weak reachable target - back to the normal build order", "bot");
    }
    // A critically small army (under 8 units incl. those in training) trains first: economy and research only get what is left over.
    const unitCount = s.armies.reduce((a, x) => a + x.units.length, 0) + s.provinces.reduce((a, p) => a + (p.producing ?? 0), 0);
    const tinyArmy = unitCount < 8;
    // No province can train ground units (their buildings were lost or never built) and the army is tiny: the building that unlocks training comes before everything else, on a thin cushion, even in an emergency.
    const groundCapable = [...options.values()].some((o) => o.productions.some((u) => { const r = roleOf(u); return r === "inf" || r === "armor" || r === "arty" || r === "aa"; }));
    let fastBuilt = new Set<number>();
    if (st.doBuild && tinyArmy && !groundCapable) {
      const thin = Object.fromEntries(Object.entries(st.reserve).map(([k, v]) => [k, v * 0.2]));
      const fast = planBuilds(s, st, options, budget, this.mem.blocked, short, lab, { only: /^(Army Base|Recruiting Office)/, reserve: thin });
      plan.push(...fast);
      fastBuilt = new Set(fast.map((d) => Number(d.args[0])));
    }
    if (st.mode === "aggressive" || opportunity || tinyArmy) {
      if (st.doMobilize) plan.push(...planMobilize(s, st, options, budget, this.mem.blocked, short, lab, emergency));
      if (st.doBuild && !emergency) plan.push(...planBuilds(s, st, options, budget, this.mem.blocked, short, lab, { skip: fastBuilt }));
      await research();
    } else {
      if (st.doBuild && !emergency) plan.push(...planBuilds(s, st, options, budget, this.mem.blocked, short, lab, { skip: fastBuilt }));
      await research();
      if (st.doMobilize) plan.push(...planMobilize(s, st, options, budget, this.mem.blocked, short, lab, emergency));
    }
    this.lastShortfall = short;
    this.lastWaiting = waitingOf(short);

    if (st.doMarket) {
      const m = await call<MarketInfo>(game, "market").catch(() => null);
      if (m) for (const [rid, info] of Object.entries(m.prices)) kb.recordPrice(rid, Math.max(info.price, info.min));
      // On war footing or with a tiny army the market uses the same thin cushion as training does (otherwise it can barely spend), and buys only for the top-priority order.
      const urgent = emergency || tinyArmy;
      const mst = urgent ? { ...st, reserve: Object.fromEntries(Object.entries(st.reserve).map(([k, v]) => [k, v * (emergency ? 0.15 : 0.25)])) } : st;
      if (m) { this.lastMarket = m; plan.push(...planMarket(s, mst, m, this.mem, budget, short, urgent)); }
    }

    if (st.doMilitary) {
      const def = planDefense(s, st, this.mem);
      plan.push(...def);
      const busy = new Set<string | number>(def.filter((d) => d.kind === "move" && d.args.length).map((d) => d.args[0] as string | number));
      plan.push(...planTruceHalts(s, this.mem));
      const attacks = planMilitary(s, st, this.mem, busy, this.intel);
      plan.push(...attacks);
      const verifying = Object.entries(this.mem.moveTries).filter(([, m]) => Date.now() - m.t < 20 * 60_000).map(([id]) => id);
      const used = new Set<string | number>([...busy, ...verifying, ...verifying.map(Number), ...attacks.filter((d) => d.kind === "move" && d.args.length).map((d) => d.args[0] as string | number)]);
      if (!this.lastEmergency) plan.push(...planRally(s, st, this.mem, this.intel, used)); // in an emergency the defence logic already concentrates
      plan.push(...planAirSea(s, st, this.mem));
    }
    if (st.doCoalition) {
      const co = await call<CoalitionInfo>(game, "coalitions").catch(() => null);
      if (co) { this.lastCoalitions = co; plan.push(...planCoalition(s, st, co, this.mem)); }
    }
    plan.push(...planCampaign(s, st, this.mem));
    if (st.doDiplomacy) plan.push(...planDiplomacy(s, st, this.mem));
    if (st.doMessaging) {
      const inbox = await call<InboxMsg[]>(game, "inbox").catch(() => []);
      this.lastInbox = inbox.slice(-60);
      for (const m of inbox) { // an answer to something I sent: remember which wording gets answered
        if (m.mine || this.mem.seenInbox.includes(m.uid)) continue;
        const ls = this.mem.lastSent[String(m.from)];
        if (ls && !ls.replied && Date.now() - ls.t < 24 * 3600_000) { ls.replied = true; kb.recordReply(ls.text); }
      }
      plan.push(...planMessages(s, st, this.mem, inbox));
    }
    return plan;
  }

  /** Execute decisions through the whitelist. Hold-type decisions (no args) are just logged. */
  async execute(game: Frame, plan: Decision[], source: "bot" | "manual") {
    let n = 0;
    for (const d of plan) {
      if (!d.args.length) {
        if (d.label.startsWith("NEEDS A HUMAN")) {
          const m = /NEEDS A HUMAN: (.+?) wrote "(.*)"$/.exec(d.label);
          this.mem.needsHuman.push({ t: Date.now(), who: m?.[1] ?? "someone", text: m?.[2] ?? d.label });
          if (this.mem.needsHuman.length > 30) this.mem.needsHuman.shift();
        }
        // Holds repeat every tick; log a given hold at most once per 30 min.
        const now = Date.now();
        const hk = d.label.replace(/[\d.]+/g, "#"); // numbers drift every tick; the situation is the same
        if (now - (this.holdLogged.get(hk) ?? 0) > 30 * 60_000) {
          this.holdLogged.set(hk, now);
          this.log("info", "hold", d.label, source, d.reason);
        }
        continue;
      }
      if (n >= 14) { this.log("warn", "limit", "Per-tick action limit reached; remaining decisions deferred", source); break; }
      if (d.kind === "message" && d.meta?.incoming && process.env.ANTHROPIC_API_KEY) {
        const pl = this.state?.players.find((p) => p.id === d.meta?.player);
        const llm = await draftReply(pl?.nation ?? "?", pl?.name ?? "?", d.meta.incoming, "friendly, peaceful, brief", this.state?.me.nation);
        if (llm) { d.args[1] = llm; d.label += " [LLM draft]"; }
      }
      const fn = ACTION_FN[d.kind];
      if (!fn) { this.log("error", d.kind, "Blocked: not a whitelisted action", source); continue; }
      if (this.settings.dryRun && source === "bot") { this.log("info", "dry-run", d.label, source, d.reason); continue; }
      const refusedBefore = this.counters.serverRefused;
      try {
        const res = await call<{ ok: boolean; why?: string }>(game, fn, ...d.args);
        n++; this.counters.actions++;
        if (res?.ok) {
          this.log("ok", d.kind, d.label, source, d.reason);
          this.afterSuccess(d);
        } else {
          this.counters.failures++;
          if (d.kind === "move" && (d.meta?.role === "air" || d.meta?.role === "sea")) this.mem.lab.classes[d.meta.role].refused++;
          this.log("warn", d.kind, `${d.label} -> refused: ${res?.why ?? "unknown"}`, source, d.reason);
          if (d.kind === "move" && d.meta?.target) this.mem.failedTargets[d.meta.target] = Date.now();
        }
      } catch (e) {
        this.counters.failures++;
        this.log("error", d.kind, `${d.label} -> ${(e as Error).message.split("\n")[0]}`, source);
      }
      await sleep(700);
      // The server can acknowledge an order and still refuse it a moment later (the refusal arrives separately): do not re-send the same market order every few minutes.
      if (d.kind === "coalition_apply" && this.counters.serverRefused > refusedBefore) { // the application did not register (e.g. my withdrawal was still being processed): try again later, not in 72h
        delete this.mem.coalitionTried[String(d.args[0])];
        delete this.mem.coalitionInvite[String(d.args[0])]; // an invitation I cannot act on must not keep pulling me away from a working application
        const nKey = "coalitionN:" + d.args[0], n = (this.mem.blocked[nKey] ?? 0) + 1; // repeated refusals back off: 30 min, 1 h, 2 h ... 12 h
        this.mem.blocked[nKey] = n;
        const wait = Math.min(12 * 60, 30 * 2 ** (n - 1));
        this.mem.blocked["coalition:" + d.args[0]] = Date.now() + wait * 60_000;
        kb.recordCoalition(this.mem.coalitionOpen?.size ?? 1, "refused"); this.mem.coalitionOpen = null;
        this.log("info", "coalition", `Coalition application refused by the server (${n}x); will retry in ${wait} min`, source);
      }
      if (d.kind === "market" && this.counters.serverRefused > refusedBefore) {
        this.mem.blocked["market:" + (d.args[0] ? "buy" : "sell") + ":" + d.args[3]] = Date.now() + 2 * 3600_000;
        this.log("info", "market", `Backing off ${d.args[0] ? "buying" : "selling"} resource ${d.args[3]} for 2h: the server refused the order`, source);
      }
    }
  }

  private afterSuccess(d: Decision) {
    const now = Date.now();
    if (d.kind === "move" && d.meta?.target) {
      const k = String(d.args[0]), prev = this.mem.moveTries[k];
      this.mem.moveTries[k] = prev && prev.target === d.meta.target && now - prev.t < 20 * 60_000 ? { ...prev, t: now, n: prev.n + 1 } : { target: d.meta.target, t: now, n: 1, declared: false };
      const army = this.state?.armies.find((a) => String(a.id) === String(d.args[0]));
      let rec = this.mem.attacks.find((x) => x.target === d.meta!.target && now - x.t < 30 * 60_000);
      if (!rec) { rec = { t: now, target: d.meta.target, mode: this.effectiveMode, ids: [], units: 0, ratio: d.meta.ratio, human: d.meta.human }; this.mem.attacks.push(rec); }
      if (army && !rec.ids.includes(army.id)) { rec.ids.push(army.id); rec.units += army.units.length; }
      this.mem.assigned[String(d.args[0])] = { target: d.meta.target, t: now };
    }
    if (d.kind === "move" && (d.meta?.role === "defence" || d.meta?.role === "rally")) this.mem.assigned[String(d.args[0])] = { target: d.meta.aim ?? 0, t: now }; // do not re-issue the same order every tick
    if (d.kind === "move" && (d.meta?.role === "air" || d.meta?.role === "sea")) {
      this.mem.assigned[String(d.args[0])] = { target: d.meta.aim ?? 0, t: now };
      this.mem.lab.classes[d.meta.role].sorties++;
    }
    if (d.kind === "build" || d.kind === "mobilize") {
      const [pid, uid] = d.args as [number, number];
      const prov = this.state?.provinces.find((x) => x.id === pid);
      const before = d.kind === "build" ? prov?.constructing ?? 0 : prov?.producing ?? 0;
      this.pending.push({ key: d.kind + ":" + pid + ":" + uid, kind: d.kind, pid, uid, before, label: d.label });
    }
    if (d.kind === "message") {
      this.mem.lastMessaged[d.args[0] as number] = now; this.mem.sentMessagesLog.push(now);
      const text = String(d.args[1] ?? ""); if (text) { this.mem.lastSent[String(d.args[0])] = { text, t: now, replied: false }; kb.recordSent(text); }
    }
    if (d.kind === "cancel_order" && d.meta?.resource !== undefined && d.meta.side !== "sell") { const k = String(d.meta.resource); this.mem.bidBump[k] = Math.min(12, (this.mem.bidBump[k] ?? 0) + 2); }
    if (d.kind === "market") this.mem.orderPlacedAt[String(d.args[3])] = now;
    if (d.kind === "coalition_apply") {
      this.mem.coalitionTried[String(d.args[0])] = now;
      const size = this.lastCoalitions?.list.find((c) => c.id === d.args[0])?.members ?? 1;
      this.mem.coalitionOpen = { id: Number(d.args[0]), size, t: now };
      kb.recordCoalition(size, "applied");
    }
    if (d.kind === "relation") {
      const [pid, rel] = d.args as [number, number];
      if (rel === -2) this.mem.warDeclaredAt[pid] = now;
      else {
        this.mem.lastPeaceOffer[pid] = now;
        if (rel >= 1 && !d.label.startsWith("Accept peace") && !this.mem.peaceOpen[String(pid)]) this.mem.peaceOpen[String(pid)] = { t: now, kind: this.state?.players.find((p) => p.id === pid)?.human ? "human" : "ai" };
      }
    }
  }

  /** Manual command from the dashboard (goes through the same whitelist). */
  async manual(d: Decision) {
    const game = this.frame();
    if (!game) throw new Error("game not connected");
    await this.execute(game, [d], "manual");
  }
}
