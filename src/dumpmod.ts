// Read the game's static rules ("mod": units, buildings, research, relations) from the running client into data/*.json.
// The bot does this itself on first run (runner.ts), so these files are never shipped with the project.
// Manual run: npx tsx src/dumpmod.ts
import type { Frame } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { rulesDir } from "./bot/rules.js";

const KEYS = ["upgrades", "units", "researchTypes", "unitTypes", "relations", "resourceEntries", "terrainTypes", "armyStackingPenaltyConfig", "levelUpgrades", "options", "damageTypes", "provinceStates", "mobilizationClassConfig"];

export async function dumpRules(game: Frame, dir = rulesDir(), log: (s: string) => void = () => {}): Promise<string[]> {
  await game.waitForFunction("!!window.hup && !!hup.getMod()", null, { timeout: 60000 });
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const key of KEYS) {
    const json = (await game.evaluate(`(() => {
      const seen = new WeakSet();
      const lim = (v, d) => {
        if (v === null || typeof v !== "object") return typeof v === "function" ? undefined : v;
        if (seen.has(v)) return undefined;
        if (d <= 0) return undefined;
        seen.add(v);
        if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [k, lim(x, d - 1)]));
        if (v instanceof Set) return [...v].map((x) => lim(x, d - 1));
        if (Array.isArray(v)) return v.map((x) => lim(x, d - 1));
        const o = {};
        for (const k of Object.keys(v)) { if (k[0] === "_" && k.length > 1 && /Cache|Path/.test(k)) continue; const r = lim(v[k], d - 1); if (r !== undefined) o[k] = r; }
        return o;
      };
      return JSON.stringify(lim(hup.getMod()[${JSON.stringify(key)}], 6));
    })()`)) as string;
    writeFileSync(`${dir}/${key}.json`, json);
    written.push(key);
    log(`${key} ${(json.length / 1024).toFixed(0)} KB`);
  }
  return written;
}

// CLI
if (process.argv[1] && /dumpmod\.(ts|js)$/.test(process.argv[1])) {
  const { connect } = await import("./browser.js");
  const { browser, game } = await connect();
  await dumpRules(game, rulesDir(), console.log);
  await browser.close();
}
