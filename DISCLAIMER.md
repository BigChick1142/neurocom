# Disclaimer

**Neurocom is an unofficial, independent project.** It is not made, endorsed, sponsored or approved by Bytro Labs GmbH or by anyone connected to the game Conflict of Nations. "Conflict of Nations" and any related names or logos belong to their owners and are used here only to say which game this software works with.

## You use this at your own risk

- **It probably breaks the game's Terms of Service.** Software that plays for you (placing orders, sending messages, trading) is commonly forbidden by online games. **Your account can be warned, suspended or banned**, and you could lose progress, purchases or access. Use an account you can afford to lose. Read the game's current terms yourself; nobody here can promise what is allowed.
- **It talks to other people.** The bot can send in-game messages and propose treaties. You are responsible for everything it says and does in your name. Review its message list on the dashboard, and pause it if anything looks wrong.
- **It can lose games.** Its strategy is a best effort, not a guarantee. It makes mistakes.
- **It depends on the game's internals.** A game update can break it at any time, with no notice.
- **No warranty.** The software is provided "as is" under the license in `LICENSE`, without warranties of any kind, and the authors are not liable for any damage or loss.

## Privacy

Everything runs on your own computer. The bot does not send your game data anywhere. The only exceptions are things you switch on yourself:
- **Discord:** if you add a Discord bot token, alerts and command replies go through Discord.
- **AI drafting:** if you set `ANTHROPIC_API_KEY`, the text of messages other players send you is sent to the Anthropic API to draft replies.

Never share your `.env`, your `profile/` folder (your logged-in browser session) or your `data/` folder (other players' names and messages). They are excluded from this repository on purpose.
