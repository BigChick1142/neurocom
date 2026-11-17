// Summarise how the bot is doing from data/history.jsonl + data/activity.jsonl:  npx tsx tools/report.ts
import { existsSync, readFileSync } from "node:fs";

const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
import { defaultGameDir } from "../src/bot/games.js";
const DIR = defaultGameDir();
console.log("game folder:", DIR);
const hist = lines(DIR + "/history.jsonl") as { t: number; vp: number; provinces: number; units: number; money: number; day: number }[];
const act = lines(DIR + "/activity.jsonl") as { t: number; level: string; kind: string; text: string; source: string }[];

console.log("== Progress");
if (hist.length >= 2) {
  const a = hist[0], b = hist[hist.length - 1];
  const hrs = (b.t - a.t) / 3600_000;
  console.log(`span ${hrs.toFixed(1)}h | VP ${a.vp} -> ${b.vp} (${((b.vp - a.vp) / Math.max(hrs, 0.01)).toFixed(2)}/h) | provinces ${a.provinces} -> ${b.provinces} | units ${a.units} -> ${b.units} | money ${a.money} -> ${b.money}`);
  const need = 1850 - b.vp, rate = (b.vp - a.vp) / Math.max(hrs, 0.01);
  console.log(rate > 0 ? `at this rate: ${(need / rate / 24).toFixed(1)} days to the VP limit` : "no VP growth yet - economy/conquest still ramping");
} else console.log("not enough history yet (one sample every 5 minutes)");

console.log("\n== Actions by kind (ok / refused / error)");
const kinds = new Map<string, { ok: number; warn: number; error: number }>();
for (const e of act) {
  if (["boot", "settings", "mode", "hold", "dry-run", "conquest", "loss", "limit", "watchdog", "tick"].includes(e.kind)) continue;
  const k = kinds.get(e.kind) ?? { ok: 0, warn: 0, error: 0 };
  if (e.level === "ok") k.ok++; else if (e.level === "warn") k.warn++; else if (e.level === "error") k.error++;
  kinds.set(e.kind, k);
}
for (const [k, v] of kinds) console.log(`${k.padEnd(14)} ok ${String(v.ok).padStart(4)}  refused ${String(v.warn).padStart(4)}  error ${String(v.error).padStart(4)}`);

console.log("\n== Conquests / losses");
for (const e of act.filter((x) => x.kind === "conquest" || x.kind === "loss").slice(-15)) console.log(new Date(e.t).toLocaleString(), e.text);

console.log("\n== Most common refusals");
const refusals = new Map<string, number>();
for (const e of act.filter((x) => x.level === "warn" && /refused/.test(x.text))) { const key = e.text.replace(/\d+/g, "#").slice(0, 90); refusals.set(key, (refusals.get(key) ?? 0) + 1); }
for (const [k, v] of [...refusals].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(String(v).padStart(4), k);
