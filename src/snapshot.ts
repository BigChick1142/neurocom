// Observer: pulls a structured snapshot of the live game out of the page (read-only).
import type { Frame } from "playwright";
import { connect } from "./browser.js";
import { writeFileSync, mkdirSync } from "node:fs";

export interface ArmyInfo { id: number; owner: number; loc: number; x: number; y: number; units: number; moving: boolean; fight: number }

export interface Snapshot {
  t: number;
  me: { id: number; name: string; nation: string; vps: number; teamID: number; capitalID: number };
  resources: Record<string, { id: number; amount: number; perHour: number }>;
  provinces: { id: number; name: string; owner: number; morale: number; baseProduction: number; improvements: number[]; constructions: number; slots: number; adj: number[] }[];
  world: [number, number, number[]][]; // [provinceID, ownerID, adjacentIDs]
  armies: ArmyInfo[];
  foreignArmies: ArmyInfo[];
  players: { id: number; name: string; nation: string; team: number; vps: number; human: boolean }[];
  relations: Record<string, number>; // other playerID -> relation code from my point of view
  research: { slots: number; current: number; completed: number[] };
}

const PAGE_CODE = `(() => {
  const gs = hup.gameState;
  const ps = gs.getPlayerState();
  const players = Object.values(ps.players).filter((p) => p && p.playerID !== undefined && typeof p === "object");
  const meP = players.find((p) => p.siteUserID === hup.user.id);
  const myID = meP.playerID;
  const now = Date.now();
  const resources = {};
  const rp = gs.getResourceProfile(myID);
  for (const e of Object.values(rp.entries)) {
    if (!e.name || e.resourceID === 0) continue;
    resources[e.name] = { id: e.resourceID, amount: e.amount0 + e.rate * (now - e.time0) / 1000, perHour: e.rate * 3600 };
  }
  const land = gs.getMapState().map.locations.filter((l) => l && l.ownerID !== undefined && l.adjacentProvinceIds);
  const provinces = land.filter((l) => l.ownerID === myID).map((l) => ({
    id: l.locationID, name: l.name, owner: l.ownerID, morale: l.morale, baseProduction: l.baseProduction,
    improvements: [...(l.improvements || [])].map((u) => (u && u.id !== undefined ? u.id : u)),
    constructions: (l.constructions || []).length, slots: l.constructionSlots, adj: [...l.adjacentProvinceIds],
  }));
  const world = land.map((l) => [l.locationID, l.ownerID, [...l.adjacentProvinceIds]]);
  const allArmies = Object.values(gs.getArmyState().armies).filter((a) => !a.removed);
  const mk = (a) => ({ id: a._id ?? a.id, owner: a.ownerID, loc: a.locationID, x: a.position && a.position.x, y: a.position && a.position.y,
    units: (a.units || []).length, moving: (a.commands || []).length > 0, fight: a.fightStatus });
  const armies = allArmies.filter((a) => a.ownerID === myID).map(mk);
  const foreignArmies = allArmies.filter((a) => a.ownerID !== myID).map(mk);
  const fa = gs.getForeignAffairsState();
  const rel = (fa.relations.neighborRelations || {})[myID] || {};
  const rs = gs.getResearchState();
  return JSON.stringify({
    t: now,
    me: { id: myID, name: meP.name, nation: meP.nationName, vps: meP.vps, teamID: meP.teamID, capitalID: meP.capitalID },
    resources, provinces, world, armies, foreignArmies,
    players: players.map((p) => ({ id: p.playerID, name: p.name, nation: p.nationName, team: p.teamID, vps: p.vps, human: !p.computerPlayer })),
    relations: rel,
    research: { slots: rs.researchSlots, current: (rs.currentResearches || []).length, completed: Object.keys(rs.completedResearches || {}).filter((k) => k !== "@c").map(Number) },
  });
})()`;

export async function takeSnapshot(game: Frame): Promise<Snapshot> {
  await game.waitForFunction("!!window.hup && !!hup.gameState && !!hup.gameState.getPlayerState()", null, { timeout: 60000 });
  return JSON.parse((await game.evaluate(PAGE_CODE)) as string);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/snapshot.ts")) {
  const { browser, game } = await connect();
  const s = await takeSnapshot(game);
  mkdirSync("captures", { recursive: true });
  writeFileSync("captures/snapshot.json", JSON.stringify(s, null, 1));
  console.log(`me: ${s.me.name} (${s.me.nation}) id=${s.me.id} vps=${s.me.vps}`);
  for (const [k, v] of Object.entries(s.resources)) console.log(`  ${k}: ${v.amount.toFixed(0)} (${v.perHour >= 0 ? "+" : ""}${v.perHour.toFixed(1)}/h)`);
  console.log(`provinces: ${s.provinces.length} (world ${s.world.length}), armies: ${s.armies.length} (foreign visible ${s.foreignArmies.length}), players: ${s.players.length}`);
  console.log(`research: ${JSON.stringify(s.research)}`);
  console.log(`relations: ${JSON.stringify(s.relations)}`);
  await browser.close();
}
