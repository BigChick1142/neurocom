// Numbers for the dashboard's Stats tab, computed from a game's activity log and history file.
// Pure function (no file access) so it can be tested offline; the server reads the files and calls this.

export interface Stats {
  spanHours: number;
  record: { gained: number; lost: number; attacks: number; lostTo: { nation: string; n: number }[] };
  actions: { kind: string; label: string; n: number }[];
  market: { bought: number; boughtSpend: number; sold: number; soldIncome: number };
  diplomacy: { peaceOffers: number; messages: number; wars: number; applications: number; withdrawn: number };
  growth: { vpNow: number; vpPerHour6: number; vpPerHour24: number; provincesNow: number; provincesDelta24: number; unitsNow: number; unitsDelta24: number; moneyNow: number; moneyDelta24: number };
  reliability: { warnings: number; errors: number; refused: number };
  perHour: { t: number; actions: number; gained: number; lost: number }[];
}

const LABELS: Record<string, string> = {
  build: "Buildings started", research: "Research started", mobilize: "Units trained", move: "Army orders", market: "Market orders",
  message: "Messages sent", relation: "Diplomatic actions", coalition_apply: "Coalition applications", coalition_withdraw: "Applications withdrawn", cancel_order: "Market orders repriced",
};
const HOUR = 3600_000;

interface Entry { t: number; level?: string; kind?: string; text?: string }
interface Point { t: number; vp?: number; provinces?: number; units?: number; money?: number }

const parse = <T>(lines: string[]): T[] => {
  const out: T[] = [];
  for (const l of lines) { if (!l) continue; try { out.push(JSON.parse(l) as T); } catch { /* skip a torn line */ } }
  return out;
};

export function computeStats(activityLines: string[], historyLines: string[], now = Date.now()): Stats {
  const log = parse<Entry>(activityLines).filter((e) => typeof e.t === "number");
  const hist = parse<Point>(historyLines).filter((p) => typeof p.t === "number").sort((a, b) => a.t - b.t);

  const counts = new Map<string, number>();
  const lostTo = new Map<string, number>();
  const s: Stats = {
    spanHours: log.length ? Math.max(0, (now - log[0].t) / HOUR) : 0,
    record: { gained: 0, lost: 0, attacks: 0, lostTo: [] },
    actions: [], market: { bought: 0, boughtSpend: 0, sold: 0, soldIncome: 0 },
    diplomacy: { peaceOffers: 0, messages: 0, wars: 0, applications: 0, withdrawn: 0 },
    growth: { vpNow: 0, vpPerHour6: 0, vpPerHour24: 0, provincesNow: 0, provincesDelta24: 0, unitsNow: 0, unitsDelta24: 0, moneyNow: 0, moneyDelta24: 0 },
    reliability: { warnings: 0, errors: 0, refused: 0 },
    perHour: [],
  };
  const start = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
  for (let i = 0; i < 24; i++) s.perHour.push({ t: start + i * HOUR, actions: 0, gained: 0, lost: 0 });
  const bucket = (t: number) => (t >= start && t <= now + HOUR ? s.perHour[Math.min(23, Math.floor((t - start) / HOUR))] : null);

  for (const e of log) {
    const kind = e.kind ?? "", text = e.text ?? "", ok = e.level === "ok";
    if (e.level === "warn") s.reliability.warnings++;
    if (e.level === "error") s.reliability.errors++;
    if (kind === "server" && /refused/i.test(text)) s.reliability.refused++;
    const b = bucket(e.t);
    if (kind === "conquest") { s.record.gained++; if (b) b.gained++; continue; }
    if (kind === "loss") {
      s.record.lost++; if (b) b.lost++;
      const m = /^Lost .+? to (.+?) \(time/.exec(text);
      if (m) lostTo.set(m[1], (lostTo.get(m[1]) ?? 0) + 1);
      continue;
    }
    if (!ok || !(kind in LABELS)) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (b) b.actions++;
    if (kind === "move" && text.startsWith("Attack ")) s.record.attacks++;
    if (kind === "market") {
      const m = /^(Buy|Sell) (\d+) .+ @ (\d+)/.exec(text);
      if (m) {
        const amount = Number(m[2]), money = amount * Number(m[3]);
        if (m[1] === "Buy") { s.market.bought += amount; s.market.boughtSpend += money; } else { s.market.sold += amount; s.market.soldIncome += money; }
      }
    }
    if (kind === "message") s.diplomacy.messages++;
    if (kind === "coalition_apply") s.diplomacy.applications++;
    if (kind === "coalition_withdraw") s.diplomacy.withdrawn++;
    if (kind === "relation") { if (/^Declare war/.test(text)) s.diplomacy.wars++; else if (/peace/i.test(text)) s.diplomacy.peaceOffers++; }
  }
  s.actions = [...counts].map(([kind, n]) => ({ kind, label: LABELS[kind], n })).sort((a, b) => b.n - a.n);
  s.record.lostTo = [...lostTo].map(([nation, n]) => ({ nation, n })).sort((a, b) => b.n - a.n).slice(0, 6);

  if (hist.length) {
    const last = hist[hist.length - 1];
    const at = (ms: number) => hist.find((p) => p.t >= now - ms) ?? hist[0]; // oldest point inside the window (or the first ever)
    const d = (a: number | undefined, b: number | undefined) => (a ?? 0) - (b ?? 0);
    const p6 = at(6 * HOUR), p24 = at(24 * HOUR);
    const h6 = Math.max(1, (last.t - p6.t) / HOUR), h24 = Math.max(1, (last.t - p24.t) / HOUR);
    s.growth = {
      vpNow: last.vp ?? 0, vpPerHour6: d(last.vp, p6.vp) / h6, vpPerHour24: d(last.vp, p24.vp) / h24,
      provincesNow: last.provinces ?? 0, provincesDelta24: d(last.provinces, p24.provinces),
      unitsNow: last.units ?? 0, unitsDelta24: d(last.units, p24.units),
      moneyNow: last.money ?? 0, moneyDelta24: d(last.money, p24.money),
    };
  }
  return s;
}
