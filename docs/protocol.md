# Conflict of Nations (Bytro) protocol notes

Observed from recon captures (WW3 Apocalypse, gameID in `gameID` field). Game: world of ~153 players.

## Transport
- **Game commands**: HTTP POST JSON to `https://congs<N>.c.bytro.com/` (server number varies per game).
  Body `@c` = `ultshared.action.UltUpdateGameStateAction`, with `stateType`, `stateID`, and `actions: ["java.util.LinkedList", [ ...Action ]]`.
  Response: `UltJsonResult` -> `result.states` (map of stateType -> state).
  Every request has `hash` (per-request signature), `userAuth` (session token), `tstamp`, `requestID`. **Treat as secrets; never log/commit.**
- **Chat**: WebSocket `wss://congs<N>.c.bytro.com:8925/`. Send `UltBroadcastAction` (`/join` rooms); receive `UltBroadcastMessage` {room, author, text, siteUserID}.
- Notifications: NATS websocket `con-nats-prod.c.bytro.com:4221` (userNotification.<siteUserID>). Not needed.

## State types (`result.states[<n>]`)
| n | class | contents |
|---|-------|----------|
| 1 | UltPlayerState | `players[id]` UltPlayerProfil: name, teamID, nationName, vps, capitalID, computerPlayer, siteUserID; `teams[id]` |
| 2 | UltNewspaperState | ranking, news articles |
| 3 | UltMapState | `map.locations` provinces (compact keys, see below) |
| 4 | UltResourceState | trading offers/history, `resourceProfs[playerID]` (market orders etc.) |
| 5 | UltForeignAffairsState | `relations.neighborRelations[a][b]` = relation code (6 = ?, 99 = self, -2 = war?, 3 = ?), in-game `messages` |
| 6 | UltArmyState | `armies[id]` compact army objects |
| 23 | UltResearchState | currentResearches, completedResearches, researchSlots |
| 24 | UltGameEventState | event log (research done, etc.) |
| 29 | UltMissionState | missions |
| 30 | UltInventoryState | premium inventory |

Updates are incremental: poll with last `stateID`; `changeSet: true` means a delta to merge, not a full replace.

## Compact keys
Province (`@c:"p"`): `id`, `c` {x,y} centre, `o` owner playerID, `us` upgrades [{`id`=type, `c`=?, `e`=enabled}], `r` ?, `bp` ?, `ci` city owners list, `plv` level?, `pst`, `co` coastal?, `tp` ?, `tt` terrain/type?
Army (`@c:"a"`): `id`, `o` owner, `l` location province, `p` {x,y}, `s` size, `u` units, `c` movement path (`gc` segments: sp->tp with speed `s`), `str` strength, `def`, `at` arrival time, `terrainType`.
Unit (`@c:"u"`): `t` type id, `id`, `h` health, `s` slot, `k` kills?

## Actions (inside `actions` list)
- `UltMessageAction`: `newArticles: ["java.util.Vector",[{ @c:"ultshared.UltArticle", receiverID, senderID, authorID, messageBody, ... }]]` - in-game DM.
- `UltResearchAction`: `{researchID, cancel}`
- `UltUpdateProvinceAction`: `{provinceIDs:[..], slot, mode:1, upgrade:{@c:"mu", id:<upgradeType>, c:0, ...}}` - build/upgrade in province.
- `UltArmyAction`: `{armies:[ {id, o, l, p, u, c:[path] ...} ]}` - move/modify armies (full army object with new path `c`).

## Unknowns to resolve
- Relation code meanings; unit type IDs (`t`) and upgrade IDs (`mu.id`); resource amounts location (not yet seen - probably another stateType, e.g. a player resource state); how to attack/declare war/propose peace; combat formula.

## Client quirks learned the hard way

* `mapState.getPlayerProvinces(x)` ignores its argument and always returns *my* provinces. To see another player's land, filter `map.locations` by `ownerID`.
* Province adjacency is **asymmetric**: a neighbour can list my province without my province listing it. Build the frontier by scanning both directions.
* No recorded relation (`neighborRelations[me][them]` undefined) means the default stance, which is war. `UltChangeRelationAction` to war on such a player is a no-op. Peace is a proposal; the stance only changes when accepted.
* Server verdicts are in the response: `result.actionResults["actionReq-N"]` (1 = accepted). Accepted does not guarantee an effect (e.g. re-ordering a building the province already has is a silent no-op).
* Moving armies: select army -> `armyController.setDragTarget(Point, null, 2)` -> `sendAction()`; the client runs its own A*. Do not pass cost/slot args unless you also handle its confirm dialogs.
* Market: `UltOrder(isBuy, amount, limit, resourceID, playerID)` in `UltOrderAction`; buy orders escrow money immediately; `playerID 0` orders are the game's market maker.
* **The game clock is not the PC clock.** `amount0 + rate*(Date.now()-time0)` under-read every resource by ~30h of production (money 2.9k vs real 10.9k). Always use the entry's own `getAmount()` (synchronized server time).
* **Coalitions = "in-game alliances"** (`hup.inGameAllianceController`). Required VP scales with size: solo 1850, 2 members 2960, 5 members 5920 (~1184 each). `UltInGameAlliance#apply()` goes through `executeAction()`, which only opens a confirm dialog and sends nothing; the bot calls `controller.triggerAction(new UltApplyInGameAllianceAction)` instead. The client's `hasPendingApplicationFromCurrentPlayer()` is the truth once the server has processed it; leaving a coalition has a 24h countdown. A separate persistent "Alliance" (clan, e.g. [AET3]) is not the coalition.
