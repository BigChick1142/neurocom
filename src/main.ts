import { existsSync } from "node:fs";
import { GameManager } from "./manager.js";
import { startDashboard } from "./dashboard/server.js";
import { printBanner } from "./banner.js";
import { kb } from "./bot/knowledge.js";

if (existsSync(".env")) { try { process.loadEnvFile(".env"); } catch { /* ignore a malformed .env */ } }

printBanner();
kb.attach("data/knowledge.json"); // what every game has taught it so far
const manager = new GameManager();
startDashboard(manager, Number(process.env.PORT ?? 8787));
// Discord is optional: a missing/invalid token must never stop the game bot.
import("./discord/bot.js").then((m) => m.startDiscord(manager)).catch((e) => console.error("discord disabled:", (e as Error).message));
process.on("SIGINT", () => { manager.stop(); kb.save(); process.exit(0); });
process.on("exit", () => kb.save());
manager.start().catch((e) => { console.error("fatal:", e); process.exit(1); });
