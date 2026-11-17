// Local dashboard server. Binds to 127.0.0.1 only; mutating requests need a per-session token
// (embedded in the served page) so other websites can't drive the bot through the browser.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { researchName } from "../bot/rules.js";
import type { Bot } from "../bot/runner.js";
import type { GameManager } from "../manager.js";
import { assessThreats } from "../bot/brain.js";
import { narrate } from "./narrative.js";
import { learnedDefence } from "../bot/intel.js";
import type { Decision } from "../bot/types.js";

const HTML = () => readFileSync(new URL("./index.html", import.meta.url), "utf8");
const KINDS = new Set(["research", "build", "mobilize", "move", "relation", "message", "market", "cancel_order"]);

export function status(bot: Bot) {
  const s = bot.state;
  return {
    now: Date.now(), connected: bot.connected, settings: bot.settings, counters: bot.counters,
    state: s && {
      t: s.t, day: s.day, dayRemainingMs: s.dayRemainingMs, vpLimit: s.vpLimit, peace: s.peace, me: s.me, resources: s.resources, research: { ...s.research, current: s.research.current.map((c) => ({ ...c, name: researchName(c.id) })) },
      provinces: s.provinces.map((p) => ({ id: p.id, name: p.name, city: p.city, vp: p.vp, morale: p.morale, freeSlot: p.freeSlot, constructing: p.constructing, producing: p.producing, canMob: p.canMob, buildings: p.have?.length ?? 0 })),
      frontier: s.frontier.map((p) => ({ id: p.id, name: p.name, owner: p.owner, city: p.city, vp: p.vp })),
      armies: s.armies.map((a) => ({ id: a.id, name: a.name, loc: a.loc, units: a.units.length, str: a.str, def: a.def, hp: a.hp, maxhp: a.maxhp, moving: a.moving, fight: a.fight, kinds: [...new Set(a.units.map((u) => u.n).filter(Boolean))] })),
      enemyArmiesVisible: s.otherArmies.length,
      players: s.players.filter((p) => p.id !== 0).map((p) => ({ id: p.id, name: p.name, nation: p.nation, team: p.team, vps: p.vps, human: p.human, rel: p.rel ?? null, relBack: p.relBack ?? null })),
    },
    effectiveMode: bot.effectiveMode,
    threats: s ? assessThreats(s).slice(0, 8) : [],
    market: bot.lastMarket && { prices: bot.lastMarket.prices, mine: bot.lastMarket.mine },
    shortfall: bot.lastShortfall,
    waiting: bot.lastWaiting.map((w) => ({ label: w.label, lacks: Object.entries(w.lacks).map(([k, v]) => ({ name: s?.resources[k]?.name ?? k, amount: Math.ceil(v) })) })),
    lessons: bot.mem.lessons.slice(-8),
    enemies: Object.entries(bot.mem.enemy).map(([id, r]) => ({ id: Number(id), nation: bot.state?.players.find((p) => p.id === Number(id))?.nation, stack: Number(r.stack.toFixed(1)), lossesTo: r.lossesTo, assumed: Number(learnedDefence(bot.mem.enemy, Number(id)).toFixed(1)), need: Math.ceil(learnedDefence(bot.mem.enemy, Number(id)) * bot.settings.attackRatio.balanced) })).filter((e) => e.stack > 1 || e.lossesTo).sort((a, b) => b.stack - a.stack).slice(0, 8),
    intel: (() => {
      const names = new Map(bot.state?.players.map((p) => [p.id, p.nation]) ?? []);
      const neigh = new Set(bot.state?.frontier.map((f) => f.owner) ?? []);
      const rows = Object.values(bot.intel).filter((i) => names.get(i.id) && !i.defeated).sort((a, b) => b.weakness - a.weakness);
      const row = (i: (typeof rows)[number]) => ({ id: i.id, nation: names.get(i.id), human: i.human, neighbour: neigh.has(i.id), weakness: Number(i.weakness.toFixed(2)), why: i.why });
      return { weakest: rows.slice(0, 10).map(row), neighbours: rows.filter((i) => neigh.has(i.id)).map(row) };
    })(),
    lab: bot.lastLab && { plan: bot.lastLab, ledger: bot.mem.lab.classes, discovered: bot.mem.lab.discovered },
    coalitions: bot.lastCoalitions,
    plan: bot.lastPlan.map((d) => ({ kind: d.kind, label: d.label, reason: d.reason })),
    narrative: (() => {
      if (!s) return narrate({ connected: bot.connected, enabled: bot.settings.enabled, dryRun: bot.settings.dryRun, mode: bot.effectiveMode, auto: bot.settings.autoMode, day: 0, vp: 0, vpLimit: 0, provinces: 0, units: 0, money: 0, moneyPerHour: 0, emergency: false, opportunity: false, topThreat: null, losses2h: 0, gains2h: 0, coalition: { mine: null, pendingName: null, pendingHours: 0 }, blockedBy: [], holdReason: null, researching: [], waitingOn: [], recentErrors: 0, lastLesson: null });
      const now = Date.now();
      const recent = bot.logs.filter((l) => l.t > now - 2 * 3600_000);
      const names = new Map(s.players.map((p) => [p.id, p.nation]));
      const th = assessThreats(s).find((t) => t.threat >= 8 && t.ratio >= 1.5) ?? null;
      const pend = bot.lastCoalitions?.list.find((c) => c.pending);
      const hold = [...bot.logs].reverse().find((l) => l.kind === "hold" && l.t > now - 3600_000 && l.text.startsWith("Hold:"));
      return narrate({
        connected: bot.connected, enabled: bot.settings.enabled, dryRun: bot.settings.dryRun, mode: bot.effectiveMode, auto: bot.settings.autoMode,
        day: s.day, vp: s.me.vps, vpLimit: s.vpLimit, provinces: s.provinces.length, units: s.armies.reduce((a, x) => a + x.units.length, 0),
        money: s.resources["20"]?.amount ?? 0, moneyPerHour: s.resources["20"]?.perHour ?? 0,
        emergency: bot.lastEmergency, opportunity: bot.lastOpportunity,
        topThreat: th && { name: th.name, owners: th.owners.map((o) => names.get(o) ?? String(o)), threat: th.threat, defence: th.defence },
        losses2h: recent.filter((l) => l.kind === "loss").length, gains2h: recent.filter((l) => l.kind === "conquest").length,
        coalition: { mine: bot.lastCoalitions?.list.find((c) => c.id === bot.lastCoalitions?.mine)?.name ?? null, pendingName: pend?.name ?? null, pendingHours: pend ? (now - (bot.mem.coalitionTried[String(pend.id)] ?? now)) / 3_600_000 : 0 },
        blockedBy: [...new Set(bot.lastWaiting.slice(0, 2).flatMap((w) => Object.keys(w.lacks)))].map((k) => s.resources[k]?.name ?? k),
        holdReason: hold ? hold.text.replace(/^Hold: /, "") : null,
        researching: s.research.current.map((c) => researchName(c.id)),
        waitingOn: bot.mem.needsHuman.filter((n) => !n.resolved && n.t > now - 24 * 3600_000).map((n) => ({ who: n.who, text: n.text })),
        recentErrors: bot.logs.filter((l) => l.level === "error" && l.t > now - 1800_000).length,
        lastLesson: bot.mem.lessons.length ? (() => { const t = bot.mem.lessons[bot.mem.lessons.length - 1].text; const first = t.split(/\. (?=Their|Lesson)/)[0]; return t.includes("Lesson:") ? `${first}. From now on it attacks that player only with a concentrated force.` : null; })() : null,
      });
    })(),
    needsHuman: bot.mem.needsHuman.filter((n) => !n.resolved && n.t > Date.now() - 24 * 3600_000),
    conversations: (() => {
      const myId = s?.me.id;
      const names = new Map(s?.players.map((p) => [p.id, `${p.nation} (${p.name})`]) ?? []);
      const threads = new Map<number, { who: string; msgs: { mine: boolean; body: string; time: unknown }[] }>();
      for (const m of bot.lastInbox) {
        const other = m.mine ? m.to : m.from;
        if (other === myId || !other) continue;
        const th = threads.get(other) ?? { who: names.get(other) ?? "player " + other, msgs: [] };
        th.msgs.push({ mine: m.mine, body: String(m.body).slice(0, 300), time: m.time });
        threads.set(other, th);
      }
      return [...threads.entries()].map(([id, th]) => ({ id, who: th.who, last: th.msgs.slice(-5), waiting: !th.msgs[th.msgs.length - 1].mine })).slice(-12).reverse();
    })(),
    logs: bot.logs.slice(-400),
    history: bot.history.slice(-600),
  };
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => { b += c; if (b.length > 100_000) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  });
}

/** Status for the page: the selected game's status plus the list of games, or an empty state when no game is open yet. */
export function statusFor(manager: GameManager, bot: Bot | undefined) {
  const games = manager.list();
  if (!bot) return { noGame: true, games, gameId: null, now: Date.now() };
  return { ...status(bot), games, gameId: bot.gameId };
}

export function startDashboard(manager: GameManager, port = 8787) {
  const token = randomBytes(16).toString("hex");
  const clients = new Map<ServerResponse, string | null>(); // response -> game the page is showing
  const pick = (id: string | null | undefined) => manager.get(id) ?? manager.first();
  const push = () => { for (const [c, id] of clients) c.write(`data: ${JSON.stringify(statusFor(manager, pick(id)))}\n\n`); };
  let pending: NodeJS.Timeout | null = null;
  const schedule = () => { if (!pending) pending = setTimeout(() => { pending = null; push(); }, 400); };
  const attach = (bot: Bot) => { bot.on("update", schedule); bot.on("log", schedule); schedule(); };
  for (const b of manager.bots.values()) attach(b);
  manager.on("bot-added", attach);
  manager.on("bot-removed", schedule);

  const json = (res: ServerResponse, code: number, o: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };

  const server = createServer(async (req, res) => {
    const host = (req.headers.host ?? "").split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") { res.writeHead(403); res.end("forbidden"); return; }
    const url = new URL(req.url ?? "/", "http://localhost");
    const gameParam = url.searchParams.get("game");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(HTML().replace("__TOKEN__", token));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/games") return json(res, 200, manager.list());
      if (req.method === "GET" && url.pathname === "/api/status") return json(res, 200, statusFor(manager, pick(gameParam)));
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        clients.set(res, gameParam);
        res.write(`data: ${JSON.stringify(statusFor(manager, pick(gameParam)))}\n\n`);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (req.method === "POST") {
        if (req.headers["x-bot-token"] !== token) return json(res, 403, { error: "bad token" });
        const body = await readBody(req);
        if (url.pathname === "/api/addgame") { await manager.openTab(); return json(res, 200, { ok: true }); }
        const bot = pick(gameParam);
        if (!bot) return json(res, 409, { error: "no game is open yet" });
        if (url.pathname === "/api/settings") { bot.updateSettings(body); return json(res, 200, { ok: true, settings: bot.settings }); }
        if (url.pathname === "/api/command") {
          if (!KINDS.has(body.kind) || !Array.isArray(body.args)) return json(res, 400, { error: "bad command" });
          const d: Decision = { kind: body.kind, args: body.args, label: String(body.label ?? `Manual ${body.kind}`).slice(0, 200), reason: "manual from dashboard" };
          await bot.manual(d);
          return json(res, 200, { ok: true });
        }
        if (url.pathname === "/api/dismiss") { const t = Number(body.t); for (const n of bot.mem.needsHuman) if (n.t === t) n.resolved = true; bot.emit("update"); return json(res, 200, { ok: true }); }
        if (url.pathname === "/api/tick") { bot.tick().catch(() => {}); return json(res, 200, { ok: true }); }
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });
  server.listen(port, "127.0.0.1", () => console.log(`Dashboard: http://127.0.0.1:${port}`));
  return server;
}
