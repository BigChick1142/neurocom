// Print the player intel table from the live game: npx tsx tools/intel.ts
import { connect } from "../src/browser.js";
import { inject, call } from "../src/inject.js";
import { buildIntel, type RawIntel } from "../src/bot/intel.js";

const { game } = await connect();
await inject(game);
const raw = await call<RawIntel>(game, "intel");
const state = await call<{ players: { id: number; nation: string; name: string; vps: number }[]; frontier: { owner: number }[] }>(game, "state");
const intel = buildIntel(raw);
const byId = new Map(state.players.map((p) => [p.id, p]));
const neigh = new Set(state.frontier.map((f) => f.owner));
const rows = Object.values(intel).filter((i) => byId.get(i.id)?.nation).sort((a, b) => b.weakness - a.weakness);
const fmt = (i: (typeof rows)[number]) => `${String(i.weakness.toFixed(2)).padStart(5)} ${(byId.get(i.id)?.nation ?? "?").padEnd(16)} ${i.human ? "human" : "AI   "} ${neigh.has(i.id) ? "NEIGHBOUR" : "         "} ${i.why.join("; ")}`;
console.log("news articles:", raw.news.length, "players:", Object.keys(raw.players).length);
console.log("--- weakest 15"); rows.slice(0, 15).forEach((i) => console.log(fmt(i)));
console.log("--- strongest 6"); rows.slice(-6).forEach((i) => console.log(fmt(i)));
console.log("--- my neighbours"); rows.filter((i) => neigh.has(i.id)).forEach((i) => console.log(fmt(i)));
process.exit(0);
