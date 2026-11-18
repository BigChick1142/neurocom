// Discord side of the bot: alerts into one channel and a few owner-only slash commands, for every game being played.
// Safety: commands work for ONE user id only (DISCORD_OWNER_ID); until it is set, every command is refused.
// It can only use controls the dashboard already has (pause/resume, report, send a message). Nothing else.
import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder, type ButtonInteraction, type ChatInputCommandInteraction, type TextChannel } from "discord.js";
import { DASH_TABS, dashboardShot, inQueue } from "./shots.js";
import type { Bot, LogEntry } from "../bot/runner.js";
import type { GameManager } from "../manager.js";
import { status } from "../dashboard/server.js";
import { appIdFromToken } from "./setup.js";

const gameOption = (o: import("discord.js").SlashCommandStringOption) => o.setName("game").setDescription("Pick a game from the list (optional when only one game is still alive)").setAutocomplete(true);
const COMMANDS = [
  new SlashCommandBuilder().setName("status").setDescription("What the bot is doing right now").addStringOption(gameOption),
  new SlashCommandBuilder().setName("report").setDescription("Progress since it started").addStringOption(gameOption),
  new SlashCommandBuilder().setName("pause").setDescription("Pause the bot (it stays connected but does nothing)").addStringOption(gameOption),
  new SlashCommandBuilder().setName("resume").setDescription("Resume the bot").addStringOption(gameOption),
  new SlashCommandBuilder().setName("reply").setDescription("Send an in-game message to a player")
    .addStringOption((o) => o.setName("player").setDescription("Nation or player name").setRequired(true))
    .addStringOption((o) => o.setName("text").setDescription("What to say").setRequired(true).setMaxLength(400))
    .addStringOption(gameOption),
  new SlashCommandBuilder().setName("map").setDescription("Screenshot of the game map").addStringOption(gameOption),
  new SlashCommandBuilder().setName("dashboard").setDescription("Screenshot of a dashboard page")
    .addStringOption((o) => o.setName("page").setDescription("Which page (default Home)").addChoices(...DASH_TABS.map(([v, n]) => ({ name: n, value: v }))))
    .addStringOption(gameOption),
  new SlashCommandBuilder().setName("games").setDescription("List the games the bot is playing"),
].map((c) => c.toJSON());

const n0 = (v: number) => Math.round(v).toLocaleString("en-US");

/** Which log lines are worth a ping. Returns a one-line message or null. */
export function alertFor(e: LogEntry): string | null {
  switch (e.kind) {
    case "conquest": return `🟢 ${e.text}`;
    case "loss": return `🔴 ${e.text}`;
    case "emergency": return e.level === "warn" ? `🚨 ${e.text}` : `✅ ${e.text}`;
    case "coalition_apply": return `🤝 ${e.text}`;
    case "coalition_withdraw": return `🤝 ${e.text}`;
    case "setup": return `⚙️ ${e.text}`;
    case "watchdog": return `♻️ ${e.text}`;
    case "hold": return e.text.startsWith("NEEDS A HUMAN") ? `✋ ${e.text}` : null;
    default: return e.level === "error" ? `⚠️ ${e.kind}: ${e.text}`.slice(0, 300) : null;
  }
}

export interface DiscordStatus { configured: boolean; connected: boolean; botName: string | null; guildName: string | null; channelOk: boolean | null; ownerSet: boolean; lastError: string | null }
let state: DiscordStatus = { configured: false, connected: false, botName: null, guildName: null, channelOk: null, ownerSet: false, lastError: null };
let active: { client: Client; stop: () => void; alert: (text: string) => void } | null = null;
export const discordStatus = (): DiscordStatus => ({ ...state });

/** Disconnect and clean up (the saved settings stay in .env). */
export async function stopDiscord(): Promise<void> {
  const a = active; active = null;
  if (a) { a.stop(); await a.client.destroy().catch(() => {}); }
  state = { ...state, connected: false, botName: null, guildName: null, channelOk: null };
}

/** Post a test message the same way real alerts are delivered (channel, else a DM to the owner). */
export function sendDiscordTest(): boolean {
  if (!active) return false;
  active.alert("✅ Test from Neurocom: alerts are working.");
  return true;
}

export async function startDiscord(manager: GameManager): Promise<void> {
  await stopDiscord();
  const token = process.env.DISCORD_TOKEN;
  const appId = process.env.DISCORD_APP_ID || (token ? appIdFromToken(token) : null) || "";
  state = { configured: !!(token && appId), connected: false, botName: null, guildName: null, channelOk: null, ownerSet: !!process.env.DISCORD_OWNER_ID, lastError: null };
  if (!token || !appId) return; // not configured: the bot runs without Discord
  const disposers: (() => void)[] = [];
  const guildId = process.env.DISCORD_GUILD_ID || "", channelId = process.env.DISCORD_CHANNEL_ID || "", ownerId = process.env.DISCORD_OWNER_ID || "";

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const rest = new REST({ version: "10" }).setToken(token);

  // Alerts: queue with spacing and an hourly cap so a burst of events can never spam the channel.
  const queue: string[] = [];
  const sentAt: number[] = [];
  let pump: NodeJS.Timeout | null = null;
  let warnedChannel = false;
  const flush = async () => {
    pump = null;
    if ((!channelId && !ownerId) || !queue.length) return;
    const now = Date.now();
    while (sentAt.length && sentAt[0] < now - 3600_000) sentAt.shift();
    if (sentAt.length >= 25) { pump = setTimeout(flush, 60_000); return; }
    const text = queue.shift()!;
    try {
      const ch = (await client.channels.fetch(channelId)) as TextChannel | null;
      if (ch?.isTextBased()) { await ch.send({ content: text, allowedMentions: { parse: [] } }); sentAt.push(Date.now()); }
    } catch (e) {
      // The channel is not reachable (wrong id / bot has no access): fall back to a direct message to the owner so alerts are never lost.
      if (!warnedChannel) { warnedChannel = true; console.error("discord: cannot post in the alerts channel (" + (e as Error).message + "); sending alerts to the owner by DM instead"); }
      try { if (ownerId) { const u = await client.users.fetch(ownerId); await u.send({ content: text, allowedMentions: { parse: [] } }); sentAt.push(Date.now()); } }
      catch (e2) { console.error("discord DM failed:", (e2 as Error).message); }
    }
    if (queue.length) pump = setTimeout(flush, 1500);
  };
  const alert = (text: string) => { if (queue.length < 30) queue.push(text); if (!pump) pump = setTimeout(flush, 800); };
  // With several games running, say which one an alert is about.
  const tag = (bot: Bot) => (manager.bots.size > 1 ? `**[${bot.state?.me.nation ?? bot.gameId}]** ` : "");
  const listen = (bot: Bot) => {
    const fn = (e: LogEntry) => { const a = alertFor(e); if (a) alert(tag(bot) + a); };
    bot.on("log", fn); disposers.push(() => bot.off("log", fn));
  };
  for (const b of manager.bots.values()) listen(b);
  const onAdded = (bot: Bot) => { listen(bot); alert(`🎮 Now playing game ${bot.gameId}.`); };
  const onRemoved = (id: string) => alert(`⏹️ Stopped playing game ${id}.`);
  manager.on("bot-added", onAdded); manager.on("bot-removed", onRemoved);
  disposers.push(() => { manager.off("bot-added", onAdded); manager.off("bot-removed", onRemoved); });

  const statusEmbed = (bot: Bot) => {
    const st = status(bot), s = st.state;
    const e = new EmbedBuilder().setTitle(st.narrative.headline).setColor(st.narrative.tone === "bad" ? 0xf85149 : st.narrative.tone === "warn" ? 0xe3b341 : 0x3fb950);
    if (s) {
      const money = s.resources["20"];
      e.addFields(
        { name: "Game", value: `${s.me.nation} (${bot.gameId})`, inline: true },
        { name: "Victory points", value: `${n0(s.me.vps)} / ${n0(s.vpLimit)}`, inline: true },
        { name: "Provinces", value: n0(s.provinces.length), inline: true },
        { name: "Units", value: n0(s.armies.reduce((a, x) => a + x.units, 0)), inline: true },
        { name: "Money", value: `${n0(money?.amount ?? 0)} (${(money?.perHour ?? 0) >= 0 ? "+" : ""}${n0(money?.perHour ?? 0)}/h)`, inline: true },
        { name: "Mode", value: st.effectiveMode, inline: true },
      );
    }
    e.setDescription(st.narrative.bullets.map((b) => "• " + b).join("\n").slice(0, 1800));
    if (st.narrative.attention.length) e.addFields({ name: "Needs you", value: st.narrative.attention.map((a) => "• " + a.text).join("\n").slice(0, 1000) });
    return e;
  };

  const report = (bot: Bot) => {
    const h = bot.history; if (h.length < 2) return "Not enough history yet.";
    const a = h[0], b = h[h.length - 1], hours = (b.t - a.t) / 3_600_000;
    return `Over ${hours.toFixed(1)}h: VP ${a.vp} → ${b.vp} (${((b.vp - a.vp) / Math.max(hours, 0.1)).toFixed(2)}/h), provinces ${a.provinces} → ${b.provinces}, units ${a.units} → ${b.units}, money ${n0(a.money)} → ${n0(b.money)}.`;
  };

  const gamesText = () => manager.list().map((g) => `• ${g.nation} (${g.name})${manager.bots.get(g.id) && isOver(manager.bots.get(g.id)!) ? " **game over**" : ""} · game ${g.id} · day ${g.day} · ${g.vp} VP · ${g.connected ? (g.enabled ? "playing" : "paused") : "not connected"}`).join("\n") || "No game is open. Open one in the bot's browser window.";

  // A game is "over" once its capital is gone: it is listed last and never chosen by default.
  const isOver = (b: Bot) => { const s = b.state; return !!s && (s.provinces.length === 0 || !s.provinces.some((p) => p.id === s.me.capital)); };
  const defaultGame = (): Bot | undefined => {
    if (manager.bots.size === 1) return manager.first();
    const alive = [...manager.bots.values()].filter((b) => !isOver(b));
    return alive.length === 1 ? alive[0] : undefined;
  };
  /** The pick list for the game option: nation names, the games that are still alive first. */
  async function complete(i: import("discord.js").AutocompleteInteraction) {
    if (!ownerId || i.user.id !== ownerId) { await i.respond([]); return; }
    const typed = i.options.getFocused().toLowerCase();
    const rows = [...manager.bots.values()].map((b) => ({ b, over: isOver(b) })).sort((a, c) => Number(a.over) - Number(c.over));
    const choices = rows.filter(({ b }) => !typed || (b.state?.me.nation ?? "").toLowerCase().includes(typed) || b.gameId.startsWith(typed))
      .map(({ b, over }) => ({ name: `${b.state?.me.nation ?? "Game " + b.gameId}${over ? " (game over)" : ""} · day ${b.state?.day ?? "?"} · ${b.state?.me.vps ?? 0} VP`, value: b.gameId })).slice(0, 25);
    await i.respond(choices);
  }

  // Buttons under the status card: everything you would otherwise type.
  const buttons = (bot: Bot) => new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`neuro:map:${bot.gameId}`).setLabel("Map").setEmoji("🗺️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`neuro:dash:${bot.gameId}`).setLabel("Dashboard").setEmoji("📊").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`neuro:report:${bot.gameId}`).setLabel("Progress").setEmoji("📈").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`neuro:${bot.settings.enabled ? "pause" : "resume"}:${bot.gameId}`).setLabel(bot.settings.enabled ? "Pause" : "Resume").setEmoji(bot.settings.enabled ? "⏸️" : "▶️").setStyle(bot.settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
  );
  const nameOf = (bot: Bot) => bot.state?.me.nation ?? bot.gameId;
  type Replyable = ChatInputCommandInteraction | ButtonInteraction;
  async function sendMap(i: Replyable, bot: Bot) {
    const mine = { flags: MessageFlags.Ephemeral } as const;
    await i.deferReply(mine);
    try {
      const png = await inQueue(() => manager.gameShot(bot.gameId));
      if (!png) { await i.editReply("That game's tab is not open in the bot's browser, so there is no map to show."); return; }
      await i.editReply({ content: `🗺️ ${nameOf(bot)}: the game map right now`, files: [new AttachmentBuilder(png, { name: `map-${bot.gameId}.png` })] });
    } catch (e) { await i.editReply(`Could not take the screenshot: ${(e as Error).message.split("\n")[0]}`); }
  }
  async function sendDash(i: Replyable, bot: Bot, tab: string) {
    const mine = { flags: MessageFlags.Ephemeral } as const;
    await i.deferReply(mine);
    try {
      const png = await dashboardShot(Number(process.env.PORT ?? 8787), bot.gameId, tab);
      await i.editReply({ content: `📊 ${nameOf(bot)}: dashboard, ${DASH_TABS.find(([v]) => v === tab)?.[1] ?? tab}`, files: [new AttachmentBuilder(png, { name: `dashboard-${tab}-${bot.gameId}.png` })] });
    } catch (e) { await i.editReply(`Could not take the screenshot: ${(e as Error).message.split("\n")[0]}`); }
  }
  async function onButton(i: ButtonInteraction) {
    const mine = { flags: MessageFlags.Ephemeral } as const;
    if (!ownerId || i.user.id !== ownerId) { await i.reply({ content: "Not authorised.", ...mine }); return; }
    const [, action, gameId] = i.customId.split(":");
    const bot = manager.get(gameId);
    if (!bot) { await i.reply({ content: "That game is no longer open.", ...mine }); return; }
    if (action === "map") await sendMap(i, bot);
    else if (action === "dash") await sendDash(i, bot, "home");
    else if (action === "report") await i.reply({ content: report(bot), ...mine });
    else if (action === "pause" || action === "resume") {
      bot.updateSettings({ enabled: action === "resume" });
      await i.update({ embeds: [statusEmbed(bot)], components: [buttons(bot)] }); // the card refreshes in place, with the other button
    }
  }

  async function handle(i: ChatInputCommandInteraction) {
    const mine = { flags: MessageFlags.Ephemeral } as const;
    if (!ownerId || i.user.id !== ownerId) { await i.reply({ content: ownerId ? "Not authorised." : "Owner not set yet: add DISCORD_OWNER_ID to .env.", ...mine }); return; }
    if (i.commandName === "games") { await i.reply({ content: gamesText(), ...mine }); return; }
    // which game? explicit option, else the only one
    const q = i.options.getString("game");
    const bot = q ? manager.find(q) : defaultGame();
    if (!bot) { await i.reply({ content: manager.bots.size === 0 ? "No game is open yet." : q ? `No single game matches "${q}".\n${gamesText()}` : `Several games are still alive, pick one in the game option:\n${gamesText()}`, ...mine }); return; }
    switch (i.commandName) {
      case "status": await i.reply({ embeds: [statusEmbed(bot)], components: [buttons(bot)], ...mine }); break;
      case "map": await sendMap(i, bot); break;
      case "dashboard": await sendDash(i, bot, i.options.getString("page") ?? "home"); break;
      case "report": await i.reply({ content: report(bot), ...mine }); break;
      case "pause": bot.updateSettings({ enabled: false }); await i.reply({ content: `Paused (${bot.state?.me.nation ?? bot.gameId}).`, ...mine }); break;
      case "resume": bot.updateSettings({ enabled: true }); await i.reply({ content: `Resumed (${bot.state?.me.nation ?? bot.gameId}).`, ...mine }); break;
      case "reply": {
        const who = i.options.getString("player", true).toLowerCase(), text = i.options.getString("text", true).trim();
        const players = (bot.state?.players ?? []).filter((p) => p.human && (p.nation.toLowerCase() === who || p.name.toLowerCase() === who));
        if (players.length !== 1) { await i.reply({ content: players.length ? "More than one match; use the exact player name." : "No human player with that nation or name.", ...mine }); break; }
        await bot.manual({ kind: "message", args: [players[0].id, text], label: `Message to ${players[0].nation} (${players[0].name}) from Discord`, reason: "manual from Discord", cost: {} });
        await i.reply({ content: `Sent to ${players[0].nation} (${players[0].name}): "${text}"`, ...mine });
        break;
      }
    }
  }

  client.on("interactionCreate", (i) => {
    if (i.isAutocomplete()) complete(i).catch((e) => console.error("discord autocomplete failed:", e));
    else if (i.isButton()) onButton(i).catch((e) => console.error("discord button failed:", e));
    else if (i.isChatInputCommand()) handle(i).catch((e) => console.error("discord command failed:", e));
  });
  client.once("clientReady", async () => {
    state.connected = true; state.botName = client.user?.tag ?? null;
    console.log(`Discord: logged in as ${client.user?.tag}${ownerId ? "" : " (owner not set: commands are refused)"}`);
    state.guildName = guildId ? (client.guilds.cache.get(guildId)?.name ?? null) : null;
    if (channelId) { try { const ch = await client.channels.fetch(channelId); state.channelOk = !!ch?.isTextBased(); } catch { state.channelOk = false; } }
    try {
      await rest.put(guildId ? Routes.applicationGuildCommands(appId, guildId) : Routes.applicationCommands(appId), { body: COMMANDS });
      // Commands live in exactly one place: when a server id is set, remove any global copies (they show up as duplicates in the menu).
      if (guildId) await rest.put(Routes.applicationCommands(appId), { body: [] });
    } catch (e) { state.lastError = "Could not register the slash commands: " + (e as Error).message; console.error("discord: could not register commands:", (e as Error).message); }
    if (channelId || ownerId) alert("🤖 Neurocom is online. Use /games or /status.");
  });
  client.on("error", (e) => { state.lastError = e.message; console.error("discord error:", e.message); });
  active = { client, alert, stop: () => { disposers.forEach((d) => d()); if (pump) clearTimeout(pump); pump = null; queue.length = 0; } };
  try { await client.login(token); }
  catch (e) { state.lastError = /token/i.test((e as Error).message) ? "Discord rejected the bot token." : (e as Error).message; console.error("discord: login failed:", (e as Error).message); await stopDiscord(); }
}
