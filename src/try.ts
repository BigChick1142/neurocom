// Scratch driver: tsx src/try.ts <fn> [jsonArgs...]   e.g.  tsx src/try.ts provinceInfo 262
import { connect } from "./browser.js";
import { inject, call } from "./inject.js";

const [fn, ...rest] = process.argv.slice(2);
const { browser, game } = await connect();
await inject(game);
const res = await call(game, fn, ...rest.map((a) => JSON.parse(a)));
console.log(JSON.stringify(res, null, 1).slice(0, Number(process.env.MAX ?? 6000)));
await browser.close();
