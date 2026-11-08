# Nigel dashboard

A projector view of N1gel's current match and tonight's record. It's read-only:
it joins the game server anonymously (not with the bot's token), never reads
`visible_auction_top_bids`, and only reads `logs/`, `live.out`, `params.json` and
`data/price_table.json`. It doesn't touch the bot process.

```bash
cd bot-starter
npx tsx dashboard/server.ts          # then open http://localhost:8787 and press F11
```

Options (environment variables):

| Variable | Default | What |
|---|---|---|
| `PORT` | 8787 | Web port |
| `DASH_BOT` | N1gel | Bot to follow, by name |
| `TOURNAMENT_AT` | 22:45 | Local time for the countdown |
| `REPLAY` | off | Replay a past match from `data/` instead of the live server, e.g. `REPLAY=43096` |

PowerShell: `$env:TOURNAMENT_AT='22:45'; npx tsx dashboard/server.ts`.

Subscriptions: `bot`, `bot_stats`, `tournament`; N1gel's own `match_participant` rows;
the current match's `match_state`, `match_participant`, `auction`, `auction_result`
and `word_play`; and `rating_history` for N1gel and the top 5 bots since tonight's
first logged match.

"Likely building toward" is recomputed here from the logged rack with the same
`bestTarget` as the bot, using `params.json` and the price table, so it is a close
approximation of the bot's target, not a copy of it.
