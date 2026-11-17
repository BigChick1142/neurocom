// Discord setup helpers used by the dashboard's "Discord" card: check a bot token, discover the server, channels and owner
// from it, save the settings to .env. The token is only ever sent to discord.com and is never returned to the browser.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const API = "https://discord.com/api/v10";
export const INVITE_PERMISSIONS = 19456; // View Channel + Send Messages + Embed Links

/** A bot token starts with the bot's own id, base64-encoded. For a bot this is also its application id. */
export function appIdFromToken(token: string): string | null {
  const first = token.trim().split(".")[0];
  if (!first || !/^[A-Za-z0-9_-]+$/.test(first)) return null;
  try { const id = Buffer.from(first.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); return /^\d{15,25}$/.test(id) ? id : null; } catch { return null; }
}

export const inviteUrl = (appId: string) => `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=${INVITE_PERMISSIONS}`;

async function discord(token: string, path: string): Promise<{ status: number; json: any }> {
  const r = await fetch(API + path, { headers: { Authorization: "Bot " + token.trim() }, signal: AbortSignal.timeout(15000) });
  let json: any = null;
  try { json = await r.json(); } catch { /* no body */ }
  return { status: r.status, json };
}

export interface DetectResult {
  ok: boolean; error?: string;
  botName?: string; appId?: string; inviteUrl?: string;
  guilds?: { id: string; name: string }[];
  owner?: { id: string; name: string } | null;
}

/** Validate the token and find what the dashboard can fill in by itself. */
export async function detect(token: string): Promise<DetectResult> {
  if (!token.trim()) return { ok: false, error: "Paste the bot token first." };
  const me = await discord(token, "/users/@me").catch(() => null);
  if (!me) return { ok: false, error: "Could not reach Discord. Check your internet connection." };
  if (me.status === 401) return { ok: false, error: "Discord rejected that token. Copy it again from the Bot tab (Reset Token if needed)." };
  if (me.status !== 200 || !me.json?.id) return { ok: false, error: `Unexpected answer from Discord (${me.status}).` };
  const appId = appIdFromToken(token) ?? String(me.json.id);
  const [guilds, app] = await Promise.all([discord(token, "/users/@me/guilds").catch(() => null), discord(token, "/applications/@me").catch(() => null)]);
  const ownerRaw = app?.json?.owner;
  return {
    ok: true, botName: `${me.json.username}${me.json.discriminator && me.json.discriminator !== "0" ? "#" + me.json.discriminator : ""}`,
    appId, inviteUrl: inviteUrl(appId),
    guilds: Array.isArray(guilds?.json) ? guilds!.json.map((g: any) => ({ id: String(g.id), name: String(g.name) })) : [],
    owner: ownerRaw?.id ? { id: String(ownerRaw.id), name: String(ownerRaw.username ?? ownerRaw.id) } : null, // apps owned by a team have no single owner
  };
}

/** Text channels in a server that the bot can see. Empty when the bot has no access to any. */
export async function listChannels(token: string, guildId: string): Promise<{ ok: boolean; error?: string; channels?: { id: string; name: string }[] }> {
  if (!/^\d{15,25}$/.test(guildId)) return { ok: false, error: "That server id is not valid." };
  const r = await discord(token, `/guilds/${guildId}/channels`).catch(() => null);
  if (!r) return { ok: false, error: "Could not reach Discord." };
  if (r.status !== 200 || !Array.isArray(r.json)) return { ok: false, error: "The bot cannot see that server. Invite it first, then try again." };
  return { ok: true, channels: r.json.filter((c: any) => c.type === 0).map((c: any) => ({ id: String(c.id), name: String(c.name) })) };
}

/** Merge KEY=value pairs into .env text, keeping every other line (comments, other settings) as it was. */
export function mergeEnv(text: string, values: Record<string, string>): string {
  const lines = text.split(/\r?\n/);
  const done = new Set<string>();
  const out = lines.map((l) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(l);
    if (m && m[1] in values) { done.add(m[1]); return `${m[1]}=${values[m[1]]}`; }
    return l;
  });
  while (out.length && out[out.length - 1] === "") out.pop();
  for (const [k, v] of Object.entries(values)) if (!done.has(k)) out.push(`${k}=${v}`);
  return out.join("\n") + "\n";
}

export function saveEnv(values: Record<string, string>, file = ".env"): void {
  const header = "# Local secrets. This file is in .gitignore: never commit or share it.\n";
  const current = existsSync(file) ? readFileSync(file, "utf8") : header;
  writeFileSync(file, mergeEnv(current, values));
  for (const [k, v] of Object.entries(values)) process.env[k] = v; // take effect without restarting
}

const clean = (s: unknown) => String(s ?? "").trim().replace(/[\r\n]/g, "");
export function validateIds(v: { guildId?: string; channelId?: string; ownerId?: string }): string | null {
  for (const [name, val] of [["server", v.guildId], ["channel", v.channelId], ["owner", v.ownerId]] as const) {
    if (val && !/^\d{15,25}$/.test(clean(val))) return `The ${name} id must be a long number.`;
  }
  return null;
}
