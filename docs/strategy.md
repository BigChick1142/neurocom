# Strategy notes (what the bot is built on)

Sources: community wiki mirror (conflictnations-wiki.pages.dev: Beginner Intro, Victory, Production, Provinces,
Combat, Units, Research, Diplomatic Status, Insurgencies, Rules), the official VP FAQ, and the game's own rules data
dumped from the client (`data/*.json`: 123 building types, 147 unit types, 1,090 research items).
General strategy blogs turned up in search were low quality reposts and were not used.

## Rules that drive decisions

| Fact | Consequence in the bot |
|------|------------------------|
| Win = first to the VP limit (1,850 solo, coalition members' limits add up). VP come from conquered provinces; a city is worth ~its population (4-6 VP here), plain provinces 1. | Targets are scored by VP / estimated defence. Cities first. |
| Only units with "capture and occupy" (most infantry, not special forces) take a province. | Army mix keeps ~50% infantry. |
| Homeland city 100% production, annexed 50%, occupied 25% and occupied cities can't mobilize. | Don't expect conquests to pay for themselves immediately; economy buildings stay in homeland cities. |
| Every unit costs daily upkeep in the same resources used to build it. | Mobilization is blocked if projected net income would go negative; unit cap per mode. |
| Low morale (≈<33%) triggers insurgent revolts; conquered cities start low; war crimes / WMD hurt national morale. | Garrison recent conquests and low-morale provinces; WMD research/production off by default. |
| War with many nations lowers morale. | Only declare war on one nation at a time; offer peace to neighbours/enemies we aren't attacking. |
| Right of Way lets allies capture your cities. | Bot never grants it; coalition protection only via existing relations >= 3. |
| Research needs Rare Materials; units need Components/Manpower; buildings need Fuel/Electronics. | Economy first, market bids to cover shortages (Rare Materials is the usual bottleneck). |
| Stacking penalties: oversized stacks lose strength. | (Not modelled yet - groups are formed by distance until the strength ratio is met.) |

## Decision order each tick (`runner.plan`)

1. Economy buildings (value ÷ cost ÷ build-time; 10-day builds skipped) - they get first call on scarce resources.
2. Research (core units by priority ÷ cost).
3. Mobilize (role mix, upkeep-safe, capped).
4. Market (stock scarce inputs; escalate stale bids).
5. Defence (reinforce threatened cities) then offence (strength ratio gated, war declared first, one target nation).
6. Diplomacy / messages (rate-limited, template or optional LLM-drafted).

Auto mode: economy on day 1 or with <10 units; balanced by default; aggressive only with a feasible target,
>=25 units, >12k money and 2.5× the estimated defence.

## Not implemented yet

Naval / air / amphibious operations, missiles & WMD, stacking-penalty-aware army composition, unit upgrades,
selling surplus on the market, coalition/alliance management, automatic parameter tuning from outcomes
(`npm run report` summarises history for manual tuning).

## Economy & coalition layer (added)
- Market is demand-driven: planners report a *shortfall* (what the best unaffordable build/research/unit lacks); the market buys exactly that (bid rounded up to the ask) and sells *idle surplus* (stock above a per-resource keep level, not needed by any wanted item, not consumed at a net loss) to the market maker's standing bid when money is the bottleneck or the pile is huge.
- Coalition: solo play (~2 VP/h) cannot reach 1850; a coalition shares one victory limit and right of way. The bot applies to the best-progress coalition without a member it is at war with, one application at a time, withdraws after 18h of silence and tries the next (72h cooldown per coalition).

## Air & naval learning (added)
- `src/bot/lab.ts` keeps a per-class ledger (land / air / sea) in `data/memory.json`: capital tied up (unit cost x hours alive), kills (per unit uid), losses. `labPlan` turns return-on-capital relative to land into a bounded multiplier (0.2x-3x, shrunk toward 1 on small samples); it sets the share of the force that air (base 10%) and sea (base 5%, 25% when no land targets) get, and scales air/naval research and Air Base / Naval Base building. Economy mode = 0%.
- Air/sea units are only mobilized with 2x the normal reserve margin. Fighters sortie only within 40% of their range (they must get back) at enemy armies in my land or at my attack targets; ships only engage enemy ships near the coast; 4h cooldown per army; refused orders are counted.
- Not done: amphibious invasion (transports + marines), carrier ops, bombing of provinces/buildings, missiles.

## Intel layer (newspaper + observed activity)
- `src/page/bot.js intel()` reads the newspaper (3 newest days) and player profiles; `src/bot/intel.ts` turns them into a per-player weakness score: capital occupied (+1.0), unit losses vs kills, insurgency, low morale, several simultaneous wars, no visible activity for hours (observed: the client's own active / last-login fields are NOT populated for other players), minus top-10 economy / already defeated. `weaknessMultiplier` (0.5x-2.2x) scales a target's value; an owner idle for 12h+ gets a lower defence guess and a 15% lower force margin. `npx tsx tools/intel.ts` prints the live table; the dashboard status exposes `intel`.
- Opportunity rule: when a weak reachable owner exists, the army is built before more economy (`opportunity` log line).
- Outgunned rule: a stack >= 8 strength and >= 2x my local defence near my cities -> peace offer + one message to its owner and a 12h truce (no attacks on them meanwhile).
- `tools/dryplan.ts` shows what the build planner would pick with unlimited money plus a census of existing buildings.
- Observation: the game clock drifts faster than the PC clock (offset grew ~13h in ~4.5h), so the game may be running faster than 1x; never mix PC time with server timestamps.

## Messages, rally and dashboard (rewrite)
- `src/bot/messages.ts` is the only place the bot's words live: short casual variants per situation (apply, truce under threat, peace/trade/ally replies, hello, thanks). `compose()` never returns text already sent to that player, so repeats are impossible; when the pool is used up the bot stays silent. No unprompted greetings. Questions, accusations and threats are never answered with a template: they show up as "needs you" on the dashboard (Diplomacy tab, with a Done button). Insults and plain statements are ignored.
- `planRally` (brain.ts): idle armies that got no attack job gather at my city nearest the strongest enemy stack (else the best target, else the capital) when the force is fragmented. Garrison armies and armies ordered in the last hours are left alone; skipped during an emergency (defence already concentrates).
- Dashboard (`src/dashboard/`): Home (plain-English headline from `narrative.ts`, needs-attention list, KPIs, trends), Military, Economy, Diplomacy (coalitions, conversations, nations), Activity (filtered), Settings (play-style presets, plain-language switches, advanced numbers hidden). `npx tsx tools/shot.ts` screenshots every tab on desktop and phone.

- Dashboard charts (Home): hover or touch-drag shows a crosshair on all three charts at the same moment and a details box (time, game day, the value, change vs previous reading and vs the start of the view, plus VP / provinces / units / money at that moment). Range buttons: last 6 h / 24 h / everything. `npx tsx tools/hovertest.ts` checks it in a real browser.
