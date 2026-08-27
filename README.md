# Rolling long put, delta-hedged (grid bot) simulator

Simulates a one-year facility: the client lends the desk USDT; each quarter the
desk holds a free 90-day put (notional = facility / strike) and grid-hedges its
delta in spot. ITM puts optionally roll into long calls at the carried strike.
Year-end settlement nets tokens against the loan at the strike in force.

## Model highlights
- Distance-triggered rehedging (grid-bot style), not clock-based
- Black-Scholes PVs per option (implied vol + risk-free rate)
- Put strike cap (% of start) to guarantee a minimum TOKEN delivery in-kind
- Per-quarter entry-spot / strike overrides
- Client settlement view (USDT / TOKEN repartition at face and market)
- Monte Carlo page (up to 5,000 paths) with outcome probabilities and extremes
- Reproducible sims via copy/paste seed

## Known simplifications
- GBM paths: no jumps, no vol clustering — flatters hedge tracking
- Flat execution cost in bps (negative = maker); no impact or fill risk
- No funding cost on the USDT pool — subtract funding mentally
- Single tranche per quarter: repayment split is all-or-nothing by construction

## Run
```bash
npm install
npm run dev
```

## Reference defaults
10M facility, spot 0.05, ATM puts, 80/80 vol, 0% drift, 0.50% grid step,
-0.4 bps execution, 5% rfr.
