// Everything the bot says to other players lives here.
// Rules: sound like a normal player (short, lowercase-ish, no corporate filler), never send the same text to the same
// person twice, say nothing when there is nothing worth saying, and never invent facts about myself.
import type { Memory } from "./types.js";

export type MsgKind =
  | "apply" | "peace_threat" | "negotiate" | "negotiate_again" | "reply_peace" | "reply_ally" | "reply_trade" | "reply_hostile" | "reply_hello" | "thanks";

const POOLS: Record<MsgKind, string[]> = {
  // asking to join a coalition. {coalition} = its name
  apply: [
    "hey, {me} here. any room in {coalition}? i'd rather be on a team than solo",
    "hi - {coalition} looks like a solid team. got a spot free?",
    "hey, not in a coalition yet. if {coalition} has space i'd gladly join and coordinate moves",
    "yo, {me} here. would {coalition} take one more? i'm pretty active",
  ],
  // asking an enemy that is camping near my cities for a truce
  peace_threat: [
    "your stack is sitting right next to my cities and i don't want a long fight. peace?",
    "can we call it even for now? i'll stop pushing on you if you do the same",
    "we're both just burning resources on each other. up for peace?",
    "not looking to fight you all game - want to set peace and move on?",
  ],
  // I keep losing to this player: own the war, offer to stop, keep it short and human
  negotiate: [
    "fair, i started this and you've taken a lot of it back. want to call it even and set peace? i'll keep my armies off your border",
    "you've clawed back most of what i took, so i'm happy to stop here. peace? i won't touch your provinces again",
    "we're both just losing units for nothing. i'm done attacking you, how about peace?",
    "i'll be straight: i started it and you won it back. peace from my side if you want it",
  ],
  negotiate_again: [
    "offer still stands - peace and i stay off your border",
    "still up for peace if you are. i'm not attacking you in the meantime",
    "no hard feelings, if you want peace just set it on your side and we're done",
  ],
  reply_peace: [
    "sounds good, peace set on my end",
    "yeah fine by me, setting peace now",
    "ok deal - peace from my side",
  ],
  reply_ally: [
    "can't commit to anything big right now but i won't come after you",
    "thanks, not looking to join anything atm. no beef from me though",
    "appreciate it - i'm staying flexible for now, but we're good",
  ],
  reply_trade: [
    "open to trades, just put an offer through the trade screen and i'll look at it",
    "sure, send me an offer and i'll check it",
  ],
  reply_hostile: [
    "no beef from my side, i'd rather leave you alone",
    "i'm not looking for a fight with you",
    "all good here - nothing personal",
  ],
  reply_hello: ["hey", "yo", "hey, what's up", "hi there", "sup"],
  // a coalition leader answered my application message
  thanks: [
    "ok cool, thanks for considering it",
    "thanks - shout if you need anything from me",
    "appreciate it. i'll keep to my corner in the meantime",
  ],
};

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
const hash = (s: string) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
const fill = (t: string, vars: Record<string, string>) =>
  (vars.me ? t : t.replace(/, \{me\} here/, "").replace(/\{me\} here\.? ?/, "")).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

/**
 * Pick a variant this recipient has never received (rotating by a hash so different people get different wording).
 * Returns null when every variant has been used on them - then the right move is to say nothing.
 */
export function compose(kind: MsgKind, to: number, mem: Pick<Memory, "sentTexts">, vars: Record<string, string> = {}): string | null {
  const used = new Set(mem.sentTexts[String(to)] ?? []);
  const pool = POOLS[kind];
  const start = hash(String(to) + kind) % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const text = fill(pool[(start + i) % pool.length], vars);
    if (!used.has(norm(text))) return text;
  }
  return null;
}

/** Record that this text went to this player so it is never sent to them again. */
export function remember(mem: Pick<Memory, "sentTexts">, to: number, text: string): void {
  const list = (mem.sentTexts[String(to)] ??= []);
  list.push(norm(text));
  if (list.length > 40) list.shift();
}

/** A short greeting like "hey" / "yo" / "hi" (nothing else to answer). */
export const isGreeting = (body: string) => body.trim().length <= 24 && /^(hey+|hi+|hello|yo+|sup|hiya|howdy|what'?s up|wassup)\b[\s!.,?]*$/i.test(body.trim());
