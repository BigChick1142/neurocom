// Read-only: which provinces offer an Annex / Colonize option, at what cost. CON_GAME_ID=<id> npx tsx tools/annexprobe.ts
import { connect } from "../src/browser.js";
import { inject, call } from "../src/inject.js";
import type { GameState } from "../src/bot/types.js";
import type { ProvOptions } from "../src/bot/brain.js";
const { game } = await connect(); await inject(game);
const s = await call<GameState>(game, "state");
const ids = s.provinces.filter((p) => p.city).map((p) => p.id);
const rows = await call<({ id: number } & ProvOptions)[]>(game, "options", ids.slice(0, 24), true, false);
for (const r of rows) {
  const p = s.provinces.find((x) => x.id === r.id)!;
  const hits = r.upgrades.filter((u) => /annex|colon|claim/i.test(u.name));
  console.log(p.name, "| resType", p.resType, "| morale", p.morale, "| upgrades:", r.upgrades.length, "| annex-ish:", JSON.stringify(hits));
}
console.log("city claims:", JSON.stringify(s.resources["30"]));
console.log(JSON.stringify(s.provinces.filter((p) => p.city)[0]));
process.exit(0);
