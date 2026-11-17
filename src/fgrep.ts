// Search the live client's function sources: tsx src/fgrep.ts "regex" [contextChars] [maxHits]
import { connect } from "./browser.js";

const re = process.argv[2];
const w = Number(process.argv[3] ?? 350);
const max = Number(process.argv[4] ?? 6);
const { browser, game } = await connect();
await game.waitForFunction("!!window.hup && !!hup.gameState", null, { timeout: 60000 });
const out = await game.evaluate(`(() => {
  const re = new RegExp(${JSON.stringify(re)});
  const hits = []; const seen = new Set();
  const visit = (name, fn) => {
    if (typeof fn !== "function" || seen.has(fn)) return; seen.add(fn);
    let s; try { s = Function.prototype.toString.call(fn); } catch (e) { return; }
    const m = re.exec(s); if (!m) return;
    hits.push(name + ": ..." + s.slice(Math.max(0, m.index - ${w}), m.index + ${w}));
  };
  const roots = { hup, ultshared, lzr, uber };
  const walk = (name, o, d) => {
    if (!o || d > 3 || (typeof o !== "object" && typeof o !== "function")) return;
    if (seen.has(o)) return; if (typeof o === "object") seen.add(o);
    let keys; try { keys = Object.getOwnPropertyNames(o); } catch (e) { return; }
    for (const k of keys) {
      let v; try { v = o[k]; } catch (e) { continue; }
      if (typeof v === "function") { visit(name + "." + k, v); if (v.prototype) for (const pk of Object.getOwnPropertyNames(v.prototype)) { try { visit(name + "." + k + "#" + pk, v.prototype[pk]); } catch (e) {} } }
      else if (v && typeof v === "object" && d < 3) walk(name + "." + k, v, d + 1);
    }
  };
  for (const [n, o] of Object.entries(roots)) walk(n, o, 0);
  return hits.slice(0, ${max}).join("\\n\\n=====\\n\\n");
})()`);
console.log(out);
await browser.close();
