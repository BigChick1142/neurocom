// Evaluate a JS expression inside the live game page and print it as (depth-limited) JSON.
// usage: tsx src/ev.ts "hup.gameState.getResourceProfile(92)" [depth] [maxChars]
import { connect } from "./browser.js";

const expr = process.argv[2];
const depth = Number(process.argv[3] ?? 3);
const maxChars = Number(process.argv[4] ?? 4000);
const { browser, game } = await connect();
await game.waitForFunction("!!window.hup && !!hup.gameState && !!hup.gameState.getPlayerState()", null, { timeout: 60000 });
const out = await game.evaluate(`(() => {
  const seen = new WeakSet();
  const lim = (v, d) => {
    if (v === null || typeof v !== "object") return typeof v === "function" ? "[fn]" : v;
    if (seen.has(v)) return "[circ]";
    if (d <= 0) return Array.isArray(v) ? "[arr " + v.length + "]" : "{..}";
    seen.add(v);
    if (v instanceof Map) return { __map: [...v.entries()].slice(0, 50).map(([k, x]) => [k, lim(x, d - 1)]) };
    if (v instanceof Set) return { __set: [...v].slice(0, 50).map((x) => lim(x, d - 1)) };
    if (Array.isArray(v)) return v.slice(0, 40).map((x) => lim(x, d - 1));
    const o = {};
    for (const k of Object.keys(v).slice(0, 60)) { try { o[k] = lim(v[k], d - 1); } catch (e) { o[k] = "[err]"; } }
    return o;
  };
  try { return JSON.stringify(lim((0, eval)(${JSON.stringify(expr)}), ${depth})); } catch (e) { return "ERR " + e; }
})()`);
console.log(String(out).slice(0, maxChars));
await browser.close();
