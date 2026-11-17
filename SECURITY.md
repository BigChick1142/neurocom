# Security

If you find a security problem (for example a way for a website or another program to control the bot through the dashboard, or a way secrets could leak), please report it privately by email to **thomas.api.pc@gmail.com** instead of opening a public issue.

Please include what you found, how to reproduce it, and the version. You will get a reply as soon as possible.

## What the project already does

- The dashboard listens on `127.0.0.1` only and every change request needs a per-session token.
- Only a fixed list of ordinary player actions can be sent to the game. Administrator actions that exist in the game client are never used.
- Secrets (`.env`, the browser profile, recorded traffic, game data) are in `.gitignore` and must never be committed.
