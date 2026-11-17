import { existsSync } from "node:fs";
import { GameManager } from "./manager.js";
import { startDashboard } from "./dashboard/server.js";

if (existsSync(".env")) { try { process.loadEnvFile(".env"); } catch { /* ignore a malformed .env */ } }

const manager = new GameManager();
startDashboard(manager, Number(process.env.PORT ?? 8787));
// Discord is optional: a missing/invalid token must never stop the game bot.
import("./discord/bot.js").then((m) => m.startDiscord(manager)).catch((e) => console.error("discord disabled:", (e as Error).message));
process.on("SIGINT", () => { manager.stop(); process.exit(0); });
manager.start().catch((e) => { console.error("fatal:", e); process.exit(1); });
