// Turns bot state into plain English for the dashboard: one headline, a few bullets, and a short "needs you" list.
// Pure (no I/O) so it can be tested.
export interface NarrativeInput {
  connected: boolean; enabled: boolean; dryRun: boolean;
  mode: string; auto: boolean;
  day: number; vp: number; vpLimit: number; provinces: number; units: number;
  money: number; moneyPerHour: number;
  emergency: boolean; opportunity: boolean;
  topThreat: { name: string; owners: string[]; threat: number; defence: number } | null;
  losses2h: number; gains2h: number;
  coalition: { mine: string | null; pendingName: string | null; pendingHours: number };
  blockedBy: string[];                      // resources currently blocking something the bot wants
  holdReason: string | null;                // e.g. "Ubon Ratchathani needs strength 9.7 (have 5.3)"
  researching: string[];
  waitingOn: { who: string; text: string }[]; // players whose message the bot did not answer
  recentErrors: number;
  lastLesson: string | null;
}

export interface Narrative {
  headline: string;
  tone: "ok" | "warn" | "bad";
  bullets: string[];
  attention: { level: "info" | "warn" | "bad"; text: string }[];
}

const MODE_TEXT: Record<string, string> = {
  economy: "building up the economy and staying safe",
  balanced: "balancing growth and army",
  aggressive: "pushing hard to take territory",
};

export function narrate(i: NarrativeInput): Narrative {
  const attention: Narrative["attention"] = [];
  const bullets: string[] = [];
  let headline: string;
  let tone: Narrative["tone"] = "ok";

  if (!i.connected) {
    headline = "The bot can't see the game right now";
    tone = "bad";
    attention.push({ level: "bad", text: "Not connected to the game. Check the game window is still open and logged in; the bot reconnects on its own." });
  } else if (!i.enabled) {
    headline = "Paused: the bot is watching but not doing anything";
    tone = "warn";
  } else if (i.dryRun) {
    headline = "Preview mode: the bot is planning but not acting";
    tone = "warn";
    attention.push({ level: "warn", text: "Preview (dry run) is on, so nothing is being sent to the game. Turn it off in Settings." });
  } else if (i.emergency && i.topThreat) {
    headline = `${i.topThreat.name} is under threat from ${i.topThreat.owners.join(" & ") || "an enemy"}: defending`;
    tone = "bad";
    bullets.push(`Enemy strength ${i.topThreat.threat.toFixed(0)} against my ${i.topThreat.defence.toFixed(0)} there. The bot has paused research and economy spending to build defenders and is pulling armies together.`);
  } else if (i.losses2h >= 2 && i.losses2h > i.gains2h) {
    headline = `Losing ground: ${i.losses2h} provinces lost in the last 2 hours`;
    tone = "warn";
  } else if (i.gains2h >= 1) {
    headline = `Expanding: ${i.gains2h} province${i.gains2h > 1 ? "s" : ""} captured in the last 2 hours`;
  } else if (i.opportunity) {
    headline = "Building an army to hit a weak neighbour";
  } else {
    headline = `Day ${i.day}: ${MODE_TEXT[i.mode] ?? i.mode}`;
  }

  bullets.push(`Mode: ${i.mode}${i.auto ? " (the bot picks this itself from the situation)" : " (set by you)"}.`);
  if (i.holdReason && !i.emergency) bullets.push(`Next target is waiting on more strength: ${i.holdReason}.`);
  if (i.blockedBy.length) bullets.push(`Held back by a shortage of ${i.blockedBy.join(", ")}; the market buys it when it can.`);
  if (i.researching.length) bullets.push(`Researching: ${i.researching.join(", ")}.`);
  if (i.coalition.mine) bullets.push(`In coalition ${i.coalition.mine}.`);
  else if (i.coalition.pendingName) bullets.push(`Coalition application to ${i.coalition.pendingName} is pending (${i.coalition.pendingHours.toFixed(0)}h so far, no answer).`);
  else bullets.push("Not in a coalition.");
  if (i.lastLesson) bullets.push(`Last lesson learned: ${i.lastLesson}`);

  if (i.money < 1000 && i.connected) attention.push({ level: "warn", text: `Money is low (${Math.round(i.money)}, +${Math.round(i.moneyPerHour)}/h). New units and buildings wait for it.` });
  if (i.coalition.pendingName && i.coalition.pendingHours > 12) attention.push({ level: "info", text: `${i.coalition.pendingName} hasn't answered in ${i.coalition.pendingHours.toFixed(0)}h. The bot will try another coalition at 18h.` });
  if (i.recentErrors > 0) attention.push({ level: "warn", text: `${i.recentErrors} error${i.recentErrors > 1 ? "s" : ""} in the last 30 minutes. See Activity > Problems.` });
  for (const w of i.waitingOn.slice(0, 4)) attention.push({ level: "info", text: `${w.who} wrote: "${w.text.slice(0, 90)}". The bot won't guess an answer; reply in the game if it matters.` });
  return { headline, tone, bullets, attention };
}
