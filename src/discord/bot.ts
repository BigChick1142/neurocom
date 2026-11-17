// Discord side of the bot: alerts into one channel and a few owner-only slash commands, for every game being played.
// Safety: commands work for ONE user id only (DISCORD_OWNER_ID); until it is set, every command is refused.
// It can only use controls the dashboard already has (pause/resume, report, send a message). Nothing else.
import { Client, EmbedBuilder, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder, type ChatInputCommandInteraction, type TextChannel } from "discord.js";
import type { Bot, LogEntry } from "../bot/runner.js";
import type { GameManager } from "../manager.js";
import { status } from "../dashboard/server.js";

const gameOption = (o: import("discord.js").SlashCommandStringOption) => o.setName("game").setDescription("Which game (nation, player name or game id). Optional when only one is open");
const COMMANDS = [
  new SlashCommandBuilder().setName("status").setDescription("What the bot is doing right now").addStringOption(gameOption),
  new SlashCommandBuilder().setName("report").setDescription("Progress since it started").addStringOption(gameOption),
  new SlashCommandBuilder().setName("pause").setDescription("Pause the bot (it stays connected but does nothing)").addStringOption(gameOption),
  new SlashCommandBuilder().setName("resume").setDescription("Resume the bot").addStringOption(gameOption),
  new SlashCommandBuilder().setName("reply").setDescription("Send an in-game message to a player")
    .addStringOption((o) => o.setName("player").setDescription("Nation or player name").setRequired(true))
    .addStringOption((o) => o.setName("text").setDescription("What to say").setRequired(true).setMaxLength(400))
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

export async function startDiscord(manager: GameManager): Promise<void> {
  const token = process.env.DISCORD_TOKEN, appId = process.env.DISCORD_APP_ID;
  if (!token || !appId) return; // not configured: the bot runs without Discord
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
  const listen = (bot: Bot) => bot.on("log", (e: LogEntry) => { const a = alertFor(e); if (a) alert(tag(bot) + a); });
  for (const b of manager.bots.values()) listen(b);
  manager.on("bot-added", (bot: Bot) => { listen(bot); alert(`🎮 Now playing game ${bot.gameId}.`); });
  manager.on("bot-removed", (id: string) => alert(`⏹️ Stopped playing game ${id}.`));

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

  const gamesText = () => manager.list().map((g) => `• ${g.nation} (${g.name}) · game ${g.id} · day ${g.day} · ${g.vp} VP · ${g.connected ? (g.enabled ? "playing" : "paused") : "not connected"}`).join("\n") || "No game is open. Open one in the bot's browser window.";

  async function handle(i: ChatInputCommandInteraction) {
    const mine = { flags: MessageFlags.Ephemeral } as const;
    if (!ownerId || i.user.id !== ownerId) { await i.reply({ content: ownerId ? "Not authorised." : "Owner not set yet: add DISCORD_OWNER_ID to .env.", ...mine }); return; }
    if (i.commandName === "games") { await i.reply({ content: gamesText(), ...mine }); return; }
    // which game? explicit option, else the only one
    const q = i.options.getString("game");
    const bot = q ? manager.find(q) : manager.bots.size === 1 ? manager.first() : undefined;
    if (!bot) { await i.reply({ content: manager.bots.size === 0 ? "No game is open yet." : q ? `No single game matches "${q}".\n${gamesText()}` : `Several games are open, add the game option:\n${gamesText()}`, ...mine }); return; }
    switch (i.commandName) {
      case "status": await i.reply({ embeds: [statusEmbed(bot)], ...mine }); break;
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

  client.on("interactionCreate", (i) => { if (i.isChatInputCommand()) handle(i).catch((e) => console.error("discord command failed:", e)); });
  client.once("clientReady", async () => {
    console.log(`Discord: logged in as ${client.user?.tag}${ownerId ? "" : " (owner not set: commands are refused)"}`);
    try {
      await rest.put(guildId ? Routes.applicationGuildCommands(appId, guildId) : Routes.applicationCommands(appId), { body: COMMANDS });
      // Commands live in exactly one place: when a server id is set, remove any global copies (they show up as duplicates in the menu).
      if (guildId) await rest.put(Routes.applicationCommands(appId), { body: [] });
    } catch (e) { console.error("discord: could not register commands:", (e as Error).message); }
    if (channelId || ownerId) alert("🤖 Bot online. Use /games or /status.");
  });
  client.on("error", (e) => console.error("discord error:", e.message));
  await client.login(token);
}
