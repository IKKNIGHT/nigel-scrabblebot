## Live market and adopting evolve run 5150 gen 2

The live lobby is now 6 real bots every match (all 400 recent public matches).
Tiles sell for 12.3 coins on average (common letters 10-12, X/Z/J 25-37),
about twice the old price table. Winners score about 115.

First 10 live matches with the old params: places 6,2,2,2,3,2,3,3,6,6 (avg 3.5).
In the losses Nigel won 7-9 tiles and ended with 40-60 unspent coins:
it bid 5-8 on letters that sold for 8-14 (match 43140: lost 61 of 67 auctions).

Refreshed `data/price_table.json` and fitted proxies for 14 current live bots
(`live@<BotName>`, `data/profiles.json`). New pool for testing:
gaucho, nigel, live@Bron, live@RackMaw, live@GodOfThudner, live@StickBot,
live@exzell, live@Tow57-Auctioneer.

| A → B | place A → B | place B−A | score B−A |
|---|---|---|---|
| params → evolve 5150 gen 2 (300 paired, seed 4100) | 2.65 → 2.19 | −0.463 ±0.159 | +6.6 ±2.0 |

Adopted. Gen 2 bids higher: beta 1.66→2.30, idleBeta 0.50→0.77, pace 0.6→1.0.
