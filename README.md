# polymarket-ct — Polymarket Copy-Trading + Weather Prediction Agent

A production TypeScript trading bot for Polymarket with two independent strategies:

- **Copy-trading** — mirrors trades from watched wallets (Telegram-managed).
- **Weather prediction agent** — scans _"Highest temperature in &lt;city&gt;"_ markets, builds a
  calibrated probabilistic forecast from multi-model weather ensembles, computes the edge vs.
  the market, and (optionally) trades mispriced buckets with fractional-Kelly sizing under
  strict risk caps.

Both honor a global `DRY_RUN` switch and are safe to run in **alerts-only mode**.

> Runtime: **Node.js + TypeScript** (`ts-node` for CLIs, `tsc` for the production build).

## Weather agent — hybrid architecture

A 7-stage pipeline. Every data source is free/public: Open-Meteo (ensembles + deterministic),
NOAA/NWS (`api.weather.gov`), aviationweather.gov (global METAR), and Polymarket Gamma/CLOB.

| #   | Stage                            | Module(s)                                                              | What it does                                                                                                                                                                                                                                             |
| --- | -------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Market & resolution research** | `resolutionResearch.ts`, `researchCli.ts`, `resolution.ts`, `metar.ts` | Identifies the exact resolution station + source (NWS/ASOS vs airport METAR vs city-centre synoptic), timezone, rounding rule; cross-checks forecast grid vs station coords; flags ambiguities / known disputes; persists `data/weatherResolution.json`. |
| 2   | **Data ingestion**               | `forecast.ts`, `geocode.ts`                                            | Multi-model ensemble (GFS/ICON/ECMWF, ~120 members) + high-res deterministic daily max.                                                                                                                                                                  |
| 3   | **Probability engine**           | `forecast.ts`, `predictor.ts`                                          | Gaussian-KDE over members, deterministic anchoring, per-city bias calibration, measured-σ floor, lead-time widening → bucketed probabilities.                                                                                                            |
| 4   | **Edge & trading logic**         | `predictor.ts`, `engine.ts`                                            | `edge = model prob − market ask`; mode-bucket-only selection; det/ensemble-disagreement and confident-market guards.                                                                                                                                     |
| 5   | **Risk management**              | `engine.ts`, `orderSizing.ts`                                          | Fractional Kelly, per-event & daily caps, liquidity-depth checks, one-position-per-event, opt-in kill switches.                                                                                                                                          |
| 6   | **Backtesting & monitoring**     | `backtest.ts`, `backtestCli.ts`, `scoring.ts`, `scoreCli.ts`           | Forecast-error σ harness (dispersion) **+ prediction scoring vs resolved outcomes** (Brier, reliability, P&L by horizon).                                                                                                                                |
| 7   | **Orchestration**                | `engine.ts`, `index.ts`, `cli.ts`, `telegram.ts`                       | Scan loop, dry-run, alerts, env config, retries/logging.                                                                                                                                                                                                 |

## Setup

```bash
npm install
cp .env.example .env    # then fill in the required values
```

Required env: `PRIVATE_KEY`, `FUNDER_ADDRESS`, `SIGNATURE_TYPE`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`. Keep `DRY_RUN=true` to compute predictions and alerts **without placing
real orders**. All weather knobs are documented inline in `.env.example`.

### Recommended first-run order (weather agent)

```bash
npm run weather:research   # 1. extract & store exact resolution rules (do this FIRST + periodically)
npm run weather:backtest   # 2. build the per-(city,lead) forecast-error σ floor (optional)
npm run weather:scan       # 3. scan live markets for edges (read-only, no orders)
npm run weather:score      # 4. score past predictions once markets resolve (the backtest loop)
```

## CLIs (all read-only — none place orders)

| Command                                    | Purpose                                                         | Writes                        |
| ------------------------------------------ | --------------------------------------------------------------- | ----------------------------- |
| `npm run weather:research`                 | **Module 1** — extract/store resolution criteria, flag disputes | `data/weatherResolution.json` |
| `npm run weather:scan`                     | **Modules 2–4** — forecast, edge, recommended action per market | —                             |
| `npm run weather:obs`                      | Intraday settlement-lock scan vs live station obs               | —                             |
| `npm run weather:backtest [days] [cities]` | **Module 6** — forecast-error σ per (city, lead)                | `data/weatherBacktest.json`   |
| `npm run weather:score`                    | **Module 6** — Brier / reliability / P&L vs resolved outcomes   | `data/weatherScore.json`      |
| `npm run weather:diag`                     | Gate-by-gate trade diagnosis                                    | —                             |

## Example output (real market, 2026-07-16)

### 1 · Resolution research — `npm run weather:research`

```
  CITY            SOURCE   STATION   TZ                  GAP     VERIFIED RISK
  ──────────────────────────────────────────────────────────────────────────────
🔴 shanghai        SYNOPTIC ZSSS      Asia/Shanghai       14km    no       high
🟡 london          METAR    EGLL      Europe/London       23km    no       medium
🟡 los angeles     NWS      FHMC1     America/Los_Angeles —       no       medium
🟢 beijing         METAR    ZBAA      Asia/Shanghai       25km    yes      low
🟢 hong kong       METAR    VHHH      Asia/Hong_Kong      26km    yes      low
🟢 nyc             NWS      KNYC      America/New_York    —       yes      low

⚠  Flagged markets (18):
  🟡 Los Angeles [NWS]
     • NWS point→station lookup for the LA centroid picked a coastal RAWS (e.g. FHMC1),
       not the downtown USC/KLAX station the market resolves on — coastal RAWS runs cooler.
📊 Risk summary: 🟢 4 low · 🟡 5 medium · 🔴 12 high (of 21 cities).
```

### 2 · Scan — probabilities, edge, recommended action — `npm run weather:scan`

```
NYC — 2026-07-16  (lead 0d · 122 members)
🟢 resolution: NWS KNYC (verified)
Model top: 94-95°F 21.3%  |  Market top: 90-91°F 28.5%
✅ Edge: 94-95°F — model 21.3% vs ask 6.0% = +15.3% (Kelly 16.3%)

Los Angeles — 2026-07-16  (lead 0d · 122 members)
🟡 resolution: NWS FHMC1 · 3 flag(s)          ← station mismatch surfaced before any trade
Model top: 96°F or higher 42.5%  |  Market top: 80-81°F 54.0%
```

### 3 · Prediction scoring / backtest loop — `npm run weather:score`

Scores recorded model probabilities against resolved Gamma outcomes:

```
── Overall & by forecast horizon ──────────────────────────────
OVERALL    n= 25  hit  4%  Brier 0.076 (mkt 0.033 ⚠️ worse than market)  logloss 0.300  P&L -$216.76 (-61.9%)

── Reliability (are the probabilities honest?) ────────────────
   10–20%   pred 17% → obs  0%  ····················  (n=12)
   20–30%   pred 23% → obs 10%  ██··················  (n=10)

── Calibration health ─────────────────────────────────────────
🔴 DEGRADED (25 scored, 0 unresolved)
   • model Brier 0.076 is worse than the market's 0.033 (model is not adding skill)
   • realized ROI -61.9% is below the -10% floor
```

## Safety & opt-in guards (all default OFF — no behavior change until enabled)

- `DRY_RUN=true` — never places real orders (predictions + alerts only).
- `WEATHER_RESOLUTION_GUARD=true` — skip trading markets flagged **high** dispute-risk.
- `WEATHER_CALIBRATION_KILL_SWITCH=true` — pause new entries while `weather:score` reports
  **degraded** calibration.
- Always on: per-event bankroll cap, daily trade cap, liquidity-fraction cap, mode-bucket-only
  selection, confident-market disagreement guard.

## The #1 lesson (why Module 1 exists)

Weather-market P&L is dominated by matching the **exact resolution station**. A forecast that is
1–3 °C off the settlement station turns a "20% edge" into a guaranteed loss in 1° buckets.
`weather:research` (station identity + dispute flags), per-city bias calibration, and
`weather:score` (honest reliability) exist to keep the strategy grounded — a quality-first agent
will correctly **sit out** quiet or already-settled boards rather than fire mispriced longshots.

---

## Copy-trading

Mirrors fills from `TARGET_WALLETS` (managed live via Telegram). Set `COPY_ENABLED=false` for
weather-only mode. See `src/trader.ts`, `src/watcher.ts`, and `src/telegram.ts`.
