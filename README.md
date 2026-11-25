# Pump.fun Bot Sprint — Momentum Breakout Bot

[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rayhanbhuiyan01/pumpfun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rayhanbhuiyan01/pumpfun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A Solana paper-trading bot for the [Pump.fun Bot Sprint](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) on make.fun. It trades paper SOL on a 6-hour replay of pump.fun bonding-curve data (agent-fun/replay/v2), starting from 10 SOL.

## Strategy

Early-momentum breakout with strict exits:

- **Watch** every new bonding curve; track its price (virtual SOL reserves / virtual token reserves) from each batch.
- **Buy** once per coin when the price breaks out — up at least 5% from its own low, within 3% of its own high — the breakout still holds on a later batch (confirmation), and the coin is hot (at least 15 trades within 5,000 slots of first sight). One buy per coin spreads the book across many distinct coins, which is what the minimum bar (20 coins × ≥ 0.01 SOL round trip) rewards.
- **Size:** 0.05 SOL per coin, capped by the harness size cap (1% of the real SOL reserve), never below 0.02 SOL. At most 5 open positions.
- **Exit** the full position on +15% take-profit, −8% stop-loss, a trailing stop once up 10% (sell on a 15% fall from the peak), or a time stop (still below entry after 1,500 slots) to recycle the slot into a fresh coin.
- **Deterministic:** no clock, no environment, no randomness — every decision is a pure function of the hello message and the batches seen, so the two grading executions produce identical action logs.

## Dev result

Graded locally with the kit (`grade-local --driver process`): net PnL −0.405 SOL on the dev dataset (win rate 38.4%, 164 round trips over 58 coins, max drawdown 4.3%, guardrails met). The final grading runs on a fresh 6-hour window recorded after entries close, so the dev score is a calibration sample, not the final result.

## Files

- `main.ts` — the bot (entrypoint the grader runs as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — the kit's replay-v2 SDK shim, vendored byte for byte

## License

MIT — see [LICENSE](LICENSE).
