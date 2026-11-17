import { connect } from "./browser.js";

const { browser, game } = await connect();
await game.waitForFunction("!!window.hup && !!hup.gameState", null, { timeout: 60000 });
const expr = process.argv[2] ?? "hup.gameState";
const out = await game.evaluate(`(() => {
  const o = (0, eval)(${JSON.stringify(expr)});
  const names = new Set();
  let p = o;
  while (p && p !== Object.prototype) { Object.getOwnPropertyNames(p).forEach((n) => names.add(n)); p = Object.getPrototypeOf(p); }
  return [...names].map((k) => { let t; try { t = typeof o[k]; } catch (e) { t = "err"; } return k + ":" + t; }).join(", ");
})()`);
console.log(`${expr} =>\n${out}`);
await browser.close();
