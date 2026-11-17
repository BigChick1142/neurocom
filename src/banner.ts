import { readFileSync } from "node:fs";

/** A little identity in the console: shown once at startup. */
export function printBanner(): void {
  let version = "";
  try { version = JSON.parse(readFileSync("package.json", "utf8")).version ?? ""; } catch { /* running from somewhere else */ }
  const c = (s: string) => `\x1b[36m${s}\x1b[0m`, d = (s: string) => `\x1b[2m${s}\x1b[0m`;
  console.log([
    "",
    c("  _   _ _____ _   _ ____   ___   ____ ___  __  __"),
    c(" | \\ | | ____| | | |  _ \\ / _ \\ / ___/ _ \\|  \\/  |"),
    c(" |  \\| |  _| | | | | |_) | | | | |  | | | | |\\/| |"),
    c(" | |\\  | |___| |_| |  _ <| |_| | |__| |_| | |  | |"),
    c(" |_| \\_|_____|\\___/|_| \\_\\\\___/ \\____\\___/|_|  |_|"),
    "  " + d(`autopilot for grand strategy${version ? "  ·  v" + version : ""}`),
    "  " + d("unofficial · not affiliated with the game's publisher · use at your own risk"),
    "",
  ].join("\n"));
}
