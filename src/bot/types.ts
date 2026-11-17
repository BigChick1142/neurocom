// Shared types for the bot (state read from the game, settings, decisions).

export interface Res { name: string; amount: number; perHour: number }

export interface Prov {
  id: number; name: string; owner: number; city: boolean; vp: number; x: number; y: number; morale: number; adj: number[];
  // only for provinces I own:
  have?: number[]; freeSlot?: boolean; constructing?: number; producing?: number; canMob?: boolean; prodSlots?: number;
  resType?: number;
}

export interface ArmyUnit { t: number; h: number; k: number; n?: string; id?: number }
export interface Army {
  id: string | number; owner: number; loc: number; x: number; y: number; size: number; moving: boolean; fight: number;
  units: ArmyUnit[]; air: boolean; sea: boolean; removed: boolean; str: number; def: number; hp: number; maxhp: number; name: string;
}

export interface PlayerRow { id: number; name: string; nation: string; team: number; vps: number; human: boolean; cap: number; rel?: number; relBack?: number }

export interface ResearchStatus { freeSlots: number; current: { id: number; end: number }[]; completed: number[] }

export interface GameState {
  t: number; serverTs?: number; day: number; dayRemainingMs: number; vpLimit: number; peace: boolean;
  me: { id: number; name: string; nation: string; vps: number; team: number; capital: number };
  resources: Record<string, Res>; // keyed by resource id ("1" supplies, "2" components, "3" manpower, "4" rare, "5" fuel, "6" electronics, "20" money)
  provinces: Prov[]; frontier: Prov[]; armies: Army[]; otherArmies: Army[]; players: PlayerRow[];
  research: ResearchStatus;
}

export type PlayerPolicy = "none" | "ai_only" | "non_allies";
export type Mode = "economy" | "balanced" | "aggressive";

export interface Settings {
  enabled: boolean;
  dryRun: boolean; // plan + log but never execute
  mode: Mode;
  autoMode: boolean;                  // let the bot pick economy/balanced/aggressive from the situation
  tickSeconds: number;
  doResearch: boolean; doBuild: boolean; doMobilize: boolean; doMilitary: boolean; doDiplomacy: boolean; doMessaging: boolean; doMarket: boolean;
  /** apply to a coalition (shared victory limit, right of way); withdraws unanswered applications and tries the next */ doCoalition: boolean;
  warPolicy: PlayerPolicy;            // whom the bot may declare war on / attack
  allowWmd: boolean;                  // never touches WMD research/production unless true
  reserve: Record<string, number>;    // resource id -> amount to always keep banked
  maxUnits: Record<Mode, number>;     // soft cap on total armies' unit count per mode
  attackRatio: Record<Mode, number>;  // required strength / estimated defence before attacking
  protectedPlayers: number[];         // never attack
  targetPlayers: number[];            // prefer attacking these (if policy allows)
  /** An ordered plan: take the named province, then make peace with some players, then go for another player's cities. Empty = no campaign. */
  campaign: { first: string; peaceWith: number[]; then: number[]; cities: boolean };
  messageLimitPerHour: number;
  market: {
    stock: Record<string, number>; maxSpendPct: number; maxPriceMult: number; staleHours: number;
    /** sell idle surplus to fund the economy */ sell: boolean;
    /** never sell below this stock per resource id (defaults to 1.5x reserve) */ keep: Record<string, number>;
    /** only sell when money is the bottleneck (money below this multiple of its reserve) or surplus is huge */ sellWhenMoneyBelow: number;
  };
  weights: Record<string, number>;    // tunable priorities by building/research keyword
}

export type DecisionKind = "research" | "build" | "mobilize" | "move" | "relation" | "message" | "market" | "cancel_order" | "coalition_apply" | "coalition_withdraw";
export interface Decision {
  kind: DecisionKind;
  args: unknown[];       // arguments for the __bot function
  label: string;         // human readable one-liner
  reason: string;        // why
  cost?: Record<string, number>; // resources this will consume (for budgeting)
  meta?: { target?: number; player?: number; resource?: number; incoming?: string; side?: "buy" | "sell"; role?: string; aim?: number };
}

export type UnitClass = "land" | "air" | "sea";
/** Learning ledger: per unit class, how much capital I tied up (cost x hours) and what it returned. */
export interface LabMemory {
  classes: Record<UnitClass, { capitalHours: number; kills: number; lost: number; sorties: number; refused: number }>;
  seen: Record<string, { cls: UnitClass; k: number; cost: number; t: number }>; // unitUID -> last observation
  lastT: number;
  discovered: string[];                    // unit type names I have owned at least once
}
export function freshLab(): LabMemory {
  const c = () => ({ capitalHours: 0, kills: 0, lost: 0, sorties: 0, refused: 0 });
  return { classes: { land: c(), air: c(), sea: c() }, seen: {}, lastT: 0, discovered: [] };
}

/** What I have learned about an opponent from fighting near them. */
export interface EnemyRecord { stack: number; seen: number; lossesTo: number; lastLoss: number }

export interface Memory {
  campaign: { key: string; startedAt: number; firstDone: boolean; peaceAt: number }; // progress of Settings.campaign (key = its text, so a changed plan restarts)
  lastMessaged: Record<number, number>;    // playerID -> ts
  lastPeaceOffer: Record<number, number>;
  warDeclaredAt: Record<number, number>;
  capturedAt: Record<number, number>;      // provinceID -> ts
  ownedLast: number[];                     // province ids owned on previous tick
  seenInbox: number[];                     // message uids already handled
  sentMessagesLog: number[];               // timestamps (rate limit)
  orderPlacedAt: Record<string, number>;
  attacks: { t: number; target: number; mode: Mode; ids: (string | number)[]; units: number }[]; // attacks awaiting a verdict (for the tuner)
  lastTune: number;
  assigned: Record<string, { target: number; t: number }>; // armies the bot has sent somewhere (left alone while marching)
  blocked: Record<string, number>;         // action key -> blocked until ts (repeated no-ops)
  noEffect: Record<string, number>;        // action key -> consecutive no-effect count
  lab: LabMemory;                          // what air/naval/land units actually achieve (kills, losses, capital tied up)
  activity: Record<string, { sig: string; since: number }>; // owner -> signature of visible armies+VP and since when it has been unchanged
  needsHuman: { t: number; who: string; text: string; resolved?: boolean }[]; // messages the bot refused to answer with a template
  sentTexts: Record<string, string[]>;    // player id -> normalised texts already sent to them (never repeat)
  lastReplyAt: Record<string, number>;     // player id -> when I last answered their mail
  enemy: Record<string, EnemyRecord>;      // owner id -> biggest stack seen near my land (decays), how often they took my provinces
  lessons: { t: number; text: string }[]; // human-readable things the bot learned from defeats
  truce: Record<string, number>;           // owner id -> ts until which I stand down against them (I asked for peace while outgunned)
  moveTries: Record<string, { target: number; t: number; n: number; declared: boolean }>; // army id -> last attack order and whether it took effect
  coalitionInvite: Record<string, number>; // coalition id -> when one of its members invited me to join
  coalitionWarm: Record<string, number>;   // coalition id -> when one of its members answered my message without hostility
  coalitionTried: Record<string, number>;  // coalition id -> when I last applied (so I never spam one)
  bidBump: Record<string, number>;         // resource id -> price escalation after stale bids   // resource id -> ts of our last bid
  failedTargets: Record<number, number>;   // provinceID -> ts (cooldown after invalid move)
}

export const R = { SUP: "1", COMP: "2", MAN: "3", RARE: "4", FUEL: "5", ELEC: "6", MONEY: "20" } as const;
