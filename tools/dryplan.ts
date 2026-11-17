// What would the build planner pick if money were no object? (read-only) npx tsx tools/dryplan.ts
import { connect } from "../src/browser.js";
import { inject, call } from "../src/inject.js";
import { loadSettings } from "../src/bot/settings.js";
import { defaultGameDir } from "../src/bot/games.js";
import { planBuilds, type ProvOptions } from "../src/bot/brain.js";
import type { GameState } from "../src/bot/types.js";

const { game } = await connect(); await inject(game);
const s = await call<GameState>(game, "state");
const st = loadSettings(defaultGameDir());
const ids = s.provinces.filter((p) => p.freeSlot).sort((a, b) => Number(b.city) - Number(a.city) || b.vp - a.vp).map((p) => p.id);
const options = new Map<number, ProvOptions>();
for (let i = 0; i < ids.length; i += 24) {
  const rows = await call<({ id: number } & ProvOptions)[]>(game, "options", ids.slice(i, i + 24), true, false);
  for (const r of rows) options.set(r.id, r);
}
const rich = Object.fromEntries(Object.keys(s.resources).map((k) => [k, 1e9]));
const picks = planBuilds(s, { ...st, mode: "balanced" }, options, rich, {});
console.log("free-slot provinces:", ids.length, "of", s.provinces.length, " cities:", s.provinces.filter((p) => p.city).length);
console.log("what I'd build first with unlimited money (max 6 per tick):");
for (const d of picks) console.log(" -", d.label, "|", d.reason, "| cost", JSON.stringify(d.cost));
// census of what exists
const have = new Map<number, number>();
for (const p of s.provinces) for (const id of p.have ?? []) have.set(id, (have.get(id) ?? 0) + 1);
const names = new Map<number, string>();
for (const o of options.values()) for (const u of o.upgrades) names.set(u.id, u.name);
console.log("buildings present (id:count):", [...have].map(([id, n]) => `${names.get(id) ?? id}x${n}`).join(", "));
console.log("resources:", Object.fromEntries(Object.entries(s.resources).filter(([k]) => ["1", "2", "3", "4", "5", "6", "20"].includes(k)).map(([k, v]) => [v.name, Math.round(v.amount)])));
process.exit(0);
