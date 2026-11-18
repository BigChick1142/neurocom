// One-off: seed the shared knowledge base (data/knowledge.json) from the history and logs of games already on this PC.
//   npx tsx tools/learn-from-logs.ts          (stop the bot first; refuses to run twice unless --force)
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { Knowledge } from "../src/bot/knowledge.js";

const FILE = "data/knowledge.json";
if (existsSync(FILE) && !process.argv.includes("--force")) { console.log("data/knowledge.json already exists: nothing to do (use --force to add the logs again)."); process.exit(0); }

const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
const json = <T>(l: string): T | null => { try { return JSON.parse(l) as T; } catch { return null; } };
const k = new Knowledge();
k.attach(FILE); // with --force this adds to what is already there
let points = 0, losses = 0, lessons = 0;
for (const id of existsSync("data/games") ? readdirSync("data/games") : []) {
  const dir = `data/games/${id}`;
  k.seenGame(id);
  for (const l of lines(`${dir}/history.jsonl`)) {
    const p = json<{ day?: number; vp?: number; provinces?: number; units?: number; money?: number }>(l);
    if (p && p.day && p.vp !== undefined) { k.recordPace(p.day, p.vp, p.provinces ?? 0, p.units ?? 0, p.money ?? 0); points++; }
  }
  for (const l of lines(`${dir}/activity.jsonl`)) {
    const e = json<{ kind?: string; text?: string }>(l);
    if (!e || !e.text) continue;
    if (e.kind === "loss") { k.recordLoss(e.text.includes("Nothing was defending")); losses++; }
    else if (e.kind === "lesson") { k.addLesson(e.text); lessons++; }
  }
  const st = json<{ attackRatio?: Record<string, number>; maxUnits?: Record<string, number> }>(readFileSync(`${dir}/settings.json`, "utf8"));
  if (st && st.attackRatio && st.maxUnits) k.recordParams(st.attackRatio, st.maxUnits);
}
(k as unknown as { dirty: boolean }).dirty = true;
k.data.updated = Date.now();
k.save();
console.log(`learned from ${k.data.games.length} games: ${points} history points, ${losses} losses, ${lessons} lessons -> ${FILE}`);
