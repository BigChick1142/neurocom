// Prove the first-run path: read the rules from the live game into a TEMP folder and check the bot can use them. npx tsx tools/firstrun-test.ts
import { rmSync, readdirSync, statSync } from "node:fs";
import { connect } from "../src/browser.js";
import { dumpRules } from "../src/dumpmod.js";
import { reloadRules, researchName, rulesPresent, setRulesDir, unitCost, unitRangeKm, upgradeHours } from "../src/bot/rules.js";

const tmp = "captures/tmp-rules";
rmSync(tmp, { recursive: true, force: true });
const { browser, game } = await connect();
console.log("empty folder -> rulesPresent:", rulesPresent(tmp));
const t0 = Date.now();
const written = await dumpRules(game, tmp);
console.log(`dumped ${written.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("rulesPresent now:", rulesPresent(tmp));
setRulesDir(tmp); reloadRules();
console.log("upgradeHours(2276 Arms Industry L2):", upgradeHours(2276), "(expect 24)");
console.log("unitCost('Main Battle Tank'):", unitCost("Main Battle Tank"), "(expect ~4000+)");
console.log("unitRangeKm('Strike Fighter'):", unitRangeKm("Strike Fighter"), "(expect 650)");
console.log("researchName sample:", researchName(2427));
const same = readdirSync(tmp).every((f) => Math.abs(statSync(`${tmp}/${f}`).size - statSync(`data/${f}`).size) < 2048);
console.log("matches the existing data/ files in size:", same);
rmSync(tmp, { recursive: true, force: true });
await browser.close();
process.exit(0);
