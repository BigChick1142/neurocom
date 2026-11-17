// Injected into the game page. Plain JS on purpose (no TS transpile helpers).
// Exposes window.__bot: read helpers + a WHITELIST of ordinary player actions executed
// through the client's own controllers (which sign/send requests). No admin actions here.
(() => {
  const arr = (x) => (Array.isArray(x) ? x : x && x.values ? [...x.values()] : Object.values(x || {}));
  const gs = () => hup.gameState;
  const myID = () => {
    const me = arr(gs().getPlayerState().players).find((p) => p && p.siteUserID === hup.user.id);
    return me ? me.playerID : null;
  };
  const safe = (f, d) => { try { return f(); } catch (e) { return d; } };
  const costsOf = (o) => safe(() => JSON.parse(JSON.stringify(o.getBuildCosts ? o.getBuildCosts() : o.getCosts())), {});

  const B = {};
  B.myID = myID;

  B.ready = () => safe(() => !!(window.hup && hup.gameState && hup.gameState.getPlayerState() && hup.gameState.getMapState() && hup.provinceController && hup.userActionController && myID() !== null && gs().getResourceProfile(myID()) && gs().getResourceProfile(myID()).entries && gs().getArmyState() && gs().getResearchState() && gs().getForeignAffairsState()), false);

  // ---------- reads ----------
  B.resources = () => {
    // The game clock is NOT the PC clock (it was 30h apart here), so amount0 + rate*(now-time0) with Date.now() under-reads badly.
    // Use the game's own getAmount() which runs on synchronized server time.
    const out = {};
    for (const e of Object.values((gs().getResourceProfile(myID()) || {}).entries || {})) {
      if (!e.name || e.resourceID === 0) continue;
      out[e.resourceID] = { name: e.name, amount: safe(() => e.getAmount(), e.amount0), perHour: e.rate * 3600 };
    }
    return out;
  };

  B.possibleResearch = () => {
    const rs = gs().getResearchState();
    return arr(rs.getPossibleResearches()).map((r) => ({
      id: r.getItemID ? r.getItemID() : r.itemID,
      name: safe(() => r.getNameWithTier(), r.name),
      costs: costsOf(r),
      canStart: safe(() => rs.canStartResearch(r.getItemID ? r.getItemID() : r.itemID), null),
    }));
  };
  B.researchStatus = () => {
    const rs = gs().getResearchState();
    return {
      freeSlots: safe(() => rs.getNumFreeResearchSlots(), 0),
      current: arr(rs.getCurrentResearches()).map((c) => ({ id: c.researchTypeID, end: c.endTime })),
      completed: Object.keys(rs.getCompletedResearches() || {}).filter((k) => k !== "@c").map(Number),
    };
  };

  B.provinceOwner = (pid) => { const p = gs().getMapState().getProvince(pid); const c = p && safe(() => p.getCapital(), null); return p ? { id: pid, name: safe(() => p.getName(), p.name), owner: p.ownerID !== undefined ? p.ownerID : safe(() => p.getOwnerID(), 0), x: c ? c.x : undefined, y: c ? c.y : undefined } : null; };
  B.provinceInfo = (pid) => {
    const p = gs().getMapState().getProvince(pid);
    if (!p) return null;
    const upg = (u) => ({
      id: u.getItemID ? u.getItemID() : u.itemID,
      name: safe(() => u.getName(), u.upgrName),
      costs: costsOf(u),
      daily: safe(() => JSON.parse(JSON.stringify(u.getDailyCosts())), {}),
    });
    const prod = (u) => {
      const ut = u.getUnit().getUnitType();
      return {
        id: u.getItemID ? u.getItemID() : u.itemID, name: safe(() => ut.getNameWithTier(), "?"), type: safe(() => ut.getTypeName(), ""),
        costs: safe(() => JSON.parse(JSON.stringify(ut.getCosts())), {}), daily: safe(() => JSON.parse(JSON.stringify(ut.getDailyCosts())), {}),
        ship: safe(() => ut.isShip(), false), air: safe(() => ut.isAirplane(), false), buildTime: safe(() => ut.getBuildTime(), 0),
      };
    };
    return {
      id: pid, name: safe(() => p.getName(), ""), isCity: safe(() => p.isCity(), false),
      slots: safe(() => p.getConstructionSlots(), null), freeSlots: safe(() => p.hasFreeBuildSlot(), null),
      constructions: safe(() => p.getConstructionCount(), 0), producing: safe(() => p.getProductionCount(), 0),
      canMobilize: safe(() => p.canMobilizeUnits(), false), morale: p.morale,
      have: arr(safe(() => p.getUpgrades(), [])).map((u) => ({ id: u.getItemID ? u.getItemID() : u.itemID, name: safe(() => u.getName(), "") })),
      queueableUpgrades: arr(safe(() => p.getQueueableUpgrades(), [])).map(upg),
      queueableProductions: arr(safe(() => p.getQueueableProductions(), [])).map((u) => safe(() => prod(u), null)).filter(Boolean),
    };
  };

  // ---------- actions (whitelist) ----------
  B.startResearch = (id) => {
    const rs = gs().getResearchState();
    if (!rs.canStartResearch(id)) return { ok: false, why: "cannot start" };
    const r = hup.getMod().getResearch(id);
    hup.userActionController.triggerAction({ action: new ultshared.action.UltResearchAction(id), costs: r.getCosts(), gmPrice: 0, confirmCallback: null });
    return { ok: true };
  };

  B.build = (pid, upgradeID) => {
    const p = gs().getMapState().getProvince(pid);
    const u = safe(() => p.getQueueableUpgrade(upgradeID), null) || safe(() => p.getPossibleUpgrade(upgradeID), null);
    if (!u) return { ok: false, why: "not available" };
    hup.provinceController.constructBuilding([pid], u, u.getBuildCosts(), null);
    return { ok: true };
  };

  B.mobilize = (pid, upgradeID) => {
    const p = gs().getMapState().getProvince(pid);
    const u = safe(() => p.getQueueableProduction(upgradeID), null);
    if (!u) return { ok: false, why: "not available" };
    hup.provinceController.produceUnit([pid], u, null);
    return { ok: true };
  };


  // Move (or attack, if the target is hostile) via the client's own selection -> drag target -> send flow.
  B.moveArmy = (armyID, x, y) => {
    const army = gs().getArmyState().getArmy(armyID);
    if (!army) return { ok: false, why: "no such army" };
    if (army.getOwnerID() !== myID()) return { ok: false, why: "not my army" };
    const ac = hup.armyController;
    hup.armySelection.setSelected([army], false, false, false);
    ac.setCommandMode(hup.CommandModes.NONE);
    ac.setDragTarget(new lzr.engine.geom.Point(x, y), null, 2);
    if (!ac.isValidCommand) { const why = ac.message || "invalid command"; ac.cancelCommands && ac.cancelCommands(); hup.armySelection.setSelected([], false, false, false); return { ok: false, why }; }
    ac.sendAction();
    hup.armySelection.setSelected([], false, false, false);
    return { ok: true, mode: ac.commandMode };
  };

  B.provinceCenter = (pid) => { const p = gs().getMapState().getProvince(pid); const c = p && p.getCapital(); return c ? { x: c.x, y: c.y } : null; };
  B.armyInfo = (id) => { const a = gs().getArmyState().getArmy(id); return a ? { id, loc: a.getLocationID(), x: a.getPosition().x, y: a.getPosition().y, cmds: a.getCommands().length, size: a.getSize ? a.getSize() : null } : null; };

  // ---------- full state for the brain ----------
  const unitTypeIDs = (a) => safe(() => arr(a.getUnits()).map((u) => ({ t: u.unitTypeID, id: u.unitUID, h: u.health, k: u.kills, n: safe(() => u.getUnitType().getTypeName(), "") })), []);
  const armyRow = (a) => {
    const pos = a.getPosition();
    return {
      id: a.getArmyID(), owner: a.getOwnerID(), loc: a.getLocationID(), x: pos.x, y: pos.y,
      size: safe(() => a.getSize(), 0), moving: safe(() => a.getCommands().length > 0, false),
      fight: a.fightStatus, units: unitTypeIDs(a), air: safe(() => a.isAirplane(), false), sea: safe(() => a.isShip(), false),
      removed: !!a.removed, str: safe(() => a.getStrength(), 0), def: safe(() => a.getDefence(), 0), hp: safe(() => a.getHitPoints(), 0), maxhp: safe(() => a.getMaxHitPoints(), 0), name: safe(() => a.getName(), ""),
    };
  };
  B.state = () => {
    const ms = gs().getMapState(), ps = gs().getPlayerState(), id = myID(), gi = gs().getGameInfoState();
    const nr = gs().getForeignAffairsState().relations.neighborRelations || {};
    const provRow = (p, full) => {
      const c = p.getCapital();
      const row = {
        id: p.locationID, name: p.getName(), owner: p.getOwnerID(), city: safe(() => p.isCity(), false),
        vp: safe(() => p.getBuildingVictoryPoints(), 0), x: c && c.x, y: c && c.y, morale: p.morale,
        adj: [...(p.adjacentProvinceIds || [])],
      };
      if (full) {
        row.have = arr(safe(() => p.getUpgrades(), [])).map((u) => (u.getItemID ? u.getItemID() : u.itemID));
        row.freeSlot = safe(() => p.hasFreeBuildSlot(), false);
        row.constructing = safe(() => p.getConstructionCount(), 0);
        row.producing = safe(() => p.getProductionCount(), 0);
        row.canMob = safe(() => p.canMobilizeUnits(), false);
        row.prodSlots = safe(() => p.getProductionSlots(), 0);
        row.resType = safe(() => p.getProductionType(), 0);
      }
      return row;
    };
    const mineList = ms.getPlayerProvinces(id);
    const mineSet = new Set(mineList.map((p) => p.locationID));
    const provinces = mineList.map((p) => provRow(p, true));
    // Adjacency data is asymmetric (a neighbour may list us without us listing it), so scan both directions.
    const frontierIDs = new Set();
    provinces.forEach((p) => p.adj.forEach((a) => { if (!mineSet.has(a)) frontierIDs.add(a); }));
    for (const l of ms.map.locations) {
      if (!l || l.ownerID === undefined || !l.adjacentProvinceIds || l.ownerID === id || frontierIDs.has(l.locationID)) continue;
      for (const a of l.adjacentProvinceIds) if (mineSet.has(a)) { frontierIDs.add(l.locationID); break; }
    }
    const frontier = [...frontierIDs].map((a) => ms.getProvince(a)).filter(Boolean).map((p) => provRow(p, false));
    const armies = arr(gs().getArmyState().getArmies()).filter((a) => !a.removed);
    const mine = armies.filter((a) => a.getOwnerID() === id).map(armyRow);
    const others = armies.filter((a) => a.getOwnerID() !== id).map(armyRow);
    const me = ps.getPlayer(id);
    const players = arr(ps.players).filter((p) => p && p.playerID !== undefined).map((p) => ({
      id: p.playerID, name: p.name, nation: p.nationName, team: p.teamID, vps: p.vps, human: !p.computerPlayer, cap: p.capitalID,
      rel: (nr[id] || {})[p.playerID], relBack: (nr[p.playerID] || {})[id],
    }));
    return {
      t: Date.now(), serverTs: Math.max(0, ...['getMapState', 'getPlayerState', 'getArmyState'].map((n) => Number(safe(() => gs()[n]().timeStamp, 0)) || 0)), day: gi.getDayOfGame(), dayRemainingMs: gi.getNextDayTime() - gi.getCurrentDayTime(), vpLimit: gi.getCoalitionVictoryPointsRequirement(),
      peace: gi.isPeacePeriod(), me: { id, name: me.name, nation: me.nationName, vps: me.vps, team: me.teamID, capital: me.capitalID },
      resources: B.resources(), provinces, frontier, armies: mine, otherArmies: others, players,
      research: B.researchStatus(),
    };
  };

  B.inbox = () => {
    const fa = gs().getForeignAffairsState(), id = myID();
    return arr(safe(() => fa.getMessages ? fa.getMessages() : fa.messages, [])).filter(Boolean).map((m) => ({
      uid: m.getMessageUID ? m.getMessageUID() : m.messageUID, from: m.senderID, to: m.receiverID, body: m.messageBody,
      time: m.dateObj || m.timeStamp, read: id === m.receiverID ? m.readByReceiver : m.readBySender, mine: m.senderID === id,
    })).filter((m) => m.body);
  };

  // ---------- diplomacy / messaging (ordinary player actions) ----------
  B.setRelation = (pid, rel) => {
    hup.userActionController.triggerAction({ action: new ultshared.action.UltChangeRelationAction([pid], [rel]) });
    return { ok: true };
  };
  B.sendMessage = (pid, text) => {
    const me = gs().getPlayerState().getPlayer(myID());
    const target = gs().getPlayerState().getPlayer(pid);
    if (!target) return { ok: false, why: "no such player" };
    const a = new ultshared.UltArticle();
    a.setSenderID(myID()); a.setReceiverID(pid); a.setReceiverName(target.getName()); a.setMessageBody(String(text).slice(0, 1500));
    a.setAuthorID(myID()); a.setAuthor(me.getFullName ? me.getFullName() : me.name);
    if (a.setDateObj) a.setDateObj(new Date());
    const act = new ultshared.action.UltMessageAction();
    act.setNewArticles([a]);
    hup.userActionController.triggerAction({ action: act });
    return { ok: true };
  };


  // Batched option lookup: for each province id, what can be built / mobilized right now.
  B.options = (ids, wantUp, wantProd) => ids.map((pid) => {
    const p = gs().getMapState().getProvince(pid);
    if (!p) return { id: pid, upgrades: [], productions: [] };
    const upgrades = wantUp ? arr(safe(() => p.getQueueableUpgrades(), [])).map((u) => ({
      id: u.getItemID ? u.getItemID() : u.itemID, name: safe(() => u.getName(), u.upgrName), costs: costsOf(u),
      daily: safe(() => JSON.parse(JSON.stringify(u.getDailyCosts())), {}),
    })) : [];
    const productions = wantProd ? arr(safe(() => p.getQueueableProductions(), [])).map((u) => safe(() => {
      const ut = u.getUnit().getUnitType();
      return {
        id: u.getItemID ? u.getItemID() : u.itemID, name: safe(() => ut.getNameWithTier(), "?"), type: safe(() => ut.getTypeName(), ""),
        costs: safe(() => JSON.parse(JSON.stringify(ut.getCosts())), {}), daily: safe(() => JSON.parse(JSON.stringify(ut.getDailyCosts())), {}),
        ship: safe(() => ut.isShip(), false), air: safe(() => ut.isAirplane(), false), buildTime: safe(() => ut.getBuildTime(), 0),
      };
    }, null)).filter(Boolean) : [];
    return { id: pid, upgrades, productions };
  });


  // ---------- market ----------
  const flatO = (m) => (Array.isArray(m) ? m : m && m.values ? [...m.values()] : Object.values(m || {})).filter((o) => o && typeof o === "object" && o.orderID !== undefined);
  const orderRow = (o) => ({ id: o.orderID, buy: o.buy, amount: o.amount, limit: o.limit, res: o.resourceType, player: o.playerID });
  B.market = () => {
    const rs = gs().getResourceState(), id = myID();
    const entries = gs().getResourceProfile(id).entries;
    const prices = {};
    for (const e of Object.values(entries)) if (e.tradable) prices[e.resourceID] = { price: safe(() => rs.getPriceFor(e.resourceID), e.minPrice), min: e.minPrice, max: e.maxPrice };
    const asks = flatO(rs.getAllAsks()).map(orderRow), bids = flatO(rs.getAllBids()).map(orderRow);
    return { prices, asks, bids, mine: [...asks, ...bids].filter((o) => o.player === id) };
  };
  B.placeOrder = (buy, amount, limit, resourceID) => {
    amount = Math.floor(amount); limit = buy ? Math.ceil(limit) : Math.floor(limit); // never round a bid below the ask or an offer above the bid
    if (!(amount > 0) || !(limit > 0)) return { ok: false, why: "bad amount/limit" };
    const o = new ultshared.UltOrder(!!buy, amount, limit, resourceID, myID());
    hup.userActionController.triggerAction({ action: new ultshared.action.UltOrderAction(o, false) });
    return { ok: true };
  };
  B.cancelOrder = (orderID) => {
    const o = gs().getResourceState().getOrder(orderID);
    if (!o || o.playerID !== myID()) return { ok: false, why: "not my order" };
    hup.userActionController.triggerAction({ action: new ultshared.action.UltOrderAction(o, true) });
    return { ok: true };
  };

  // ---------- intel: newspaper + player profiles (read-only) ----------
  B.intel = () => {
    const ps = gs().getPlayerState();
    const players = {};
    for (const [id, p] of Object.entries(ps.players || {})) {
      players[id] = {
        id: Number(id), active: !!p.active, ai: !!p.computerPlayer, passive: !!p.passiveAI, defeated: !!p.defeated, retired: !!p.retired,
        rogue: !!p.terroristCountry || /insurg|rebel|terror/i.test(String(p.nationName || p.defaultNationName || "")), morale: safe(() => p.averageNationalMorale, null), lastLogin: Number(safe(() => p.getLastLogin(), 0)) || 0, team: p.teamID, vps: p.vps,
      };
    }
    const ns = gs().getNewspaperState();
    const news = [];
    const days = Object.keys(ns.days || {}).sort((a, b) => Number(b) - Number(a)).slice(0, 3);
    for (const d of days) for (const a of (ns.days[d].articles || [])) {
      news.push({ day: Number(d), cat: a.category || "", title: String(a.title || "").slice(0, 200), body: String(a.messageBody || "").slice(0, 2500), sid: a.senderID, rid: a.receiverID });
    }
    return { players, news };
  };

  // ---------- coalitions (in-game alliances) ----------
  const allianceCtl = () => hup.inGameAllianceController;
  B.coalitions = () => {
    const c = allianceCtl();
    const al = c.getAlliances(), arr = Array.isArray(al) ? al : Object.values(al || {});
    const mine = safe(() => c.getCurrentPlayerAlliance(), null);
    return {
      mine: mine ? mine.getID() : null,
      list: arr.map((a) => ({
        id: a.getID(), name: safe(() => a.getProfile().name, ""), members: a.getMemberCount(), score: a.getScore(), req: a.getRequiredScore(),
        leader: a.getLeaderID(), pending: !!a.hasPendingApplicationFromCurrentPlayer(),
      })),
    };
  };
  B.applyCoalition = (id) => {
    const c = allianceCtl();
    if (safe(() => c.getCurrentPlayerAlliance(), null)) return { ok: false, why: "already in a coalition" };
    const a = c.getAllianceByID(id);
    if (!a) return { ok: false, why: "no such coalition" };
    if (a.hasPendingApplicationFromCurrentPlayer()) return { ok: false, why: "application already pending" };
    // NOT a.apply(): that goes through executeAction() which only opens a confirm dialog and sends nothing until a human clicks OK.
    const act = new ultshared.action.UltApplyInGameAllianceAction();
    act.setData(id);
    c.triggerAction(act);
    return { ok: true };
  };
  B.withdrawCoalition = (id) => {
    const a = allianceCtl().getAllianceByID(id);
    if (!a || !a.hasPendingApplicationFromCurrentPlayer()) return { ok: false, why: "no pending application" };
    const act = new ultshared.action.UltWithdrawApplicationInGameAllianceAction();
    act.setData(id);
    allianceCtl().triggerAction(act);
    return { ok: true };
  };

  // Cancel "declare an unprovoked war" confirmations. Only dialogs whose text is about declaring war are touched.
  B.dismissWarDialogs = () => {
    let n = 0;
    const all = [...document.querySelectorAll("*")];
    for (const el of all) {
      if (el.children.length || (el.textContent || "").trim() !== "Cancel" || !el.offsetParent) continue;
      let box = el.parentElement;
      for (let i = 0; i < 8 && box; i++, box = box.parentElement) {
        const txt = box.textContent || "";
        if (/declare\s+an?\s+(unprovoked\s+)?war/i.test(txt) && txt.length < 600) { el.click(); n++; break; }
      }
    }
    return n;
  };

  window.__bot = B;
  return true;
})();
