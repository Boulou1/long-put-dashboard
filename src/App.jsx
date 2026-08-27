import { useState, useMemo } from "react";
import {
  ComposedChart, BarChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Legend, ReferenceLine,
} from "recharts";

/* ================= math ================= */

const ncdf = (x) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function putPV(S, K, T, vol, r) {
  const st = vol * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * vol * vol) * T) / st;
  const d2 = d1 - st;
  return K * Math.exp(-r * T) * ncdf(-d2) - S * ncdf(-d1);
}

function callPV(S, K, T, vol, r) {
  const st = vol * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * vol * vol) * T) / st;
  const d2 = d1 - st;
  return S * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2);
}

// |put delta| = N(-d1), zero rates — the hedge fraction of notional
function hedgeFrac(S, K, T, vol) {
  const st = vol * Math.sqrt(Math.max(T, 1e-9));
  const d1 = (Math.log(S / K) + 0.5 * st * st) / st;
  return ncdf(-d1);
}

/* ================= simulation =================
   The client lends `facility` USDT. Each quarter the desk holds a free
   90-day PUT (notional = capital / strike). Long put -> the hedge holds
   |delta| * notional in TOKEN: buy as price falls, sell as it rises.
   Rehedging is distance-triggered (grid-bot style).

   PUT expiry:
   - OTM: delta faded to 0, hedge already unwound, book is flat.
   - ITM: |delta| pinned to 1, book holds the FULL notional.
       itmToCall OFF -> deliver the notional at the strike (loan repaid in kind)
       itmToCall ON  -> keep the tokens; next quarter is a LONG CALL at this
                        put's strike (tokens + free option at K == call at K
                        by parity), grid-hedged exactly like the put with
                        target notl * N(-d1) at the carried strike.
   CALL expiry:
   - S >= K: delta faded to 0, inventory sold around/above K, back to PUTs.
   - S <  K: still holding, roll another call at the same strike.

   Net P&L at year end = total value - facility (the loan is repaid).      */

const PATH_SPD = 96; // steps/day for the displayed path (crossing detection)

function simulate(p, light = false) {
  const rng = mulberry32(p.seed);
  const spd = light ? 24 : PATH_SPD; // coarser in Monte Carlo for speed
  const dt = 1 / (365 * spd);
  const RL = 90 * spd;
  const N = 360 * spd;
  const sq = p.rv * Math.sqrt(dt);
  const bps = p.costBps / 10000;
  const Texp = 90 / 365;

  let S = p.spot;
  let cash = p.facility;
  let inv = 0;
  let turn = 0, fees = 0, minCash = cash, nTrades = 0;

  const daily = light ? null : [];
  const rolls = light ? null : [];

  const trade = (target) => {
    const dq = target - inv;
    if (dq === 0) return;
    const gross = Math.abs(dq) * S;
    cash -= dq * S + gross * bps;
    turn += gross;
    fees += gross * bps;
    inv = target;
    nTrades += 1;
    if (cash < minCash) minCash = cash;
  };

  let mode = "PUT";
  let K = 0, notl = 0;
  let entry = null;
  let pvTotal = 0; // signed: + puts held, − calls written
  let anchorS = S;
  let rollIdx = 0;

  const startQuarter = (idx) => {
    const cfg = p.rollCfg[idx];
    if (mode === "PUT") {
      // entry-spot teleport only allowed when the book is flat (no phantom P&L)
      if (cfg.spotMode === "manual" && cfg.spotVal > 0 && Math.abs(inv) < 1e-9) S = cfg.spotVal;
      let autoK = S * (1 + p.offset);
      // strike cap as % of the starting price: guarantees a minimum token
      // count per tranche = facility / (spot_start * capPct)
      if (p.capOn && p.capPct > 0) autoK = Math.min(autoK, p.spot * p.capPct);
      K = cfg.strikeMode === "manual" && cfg.strikeVal > 0 ? cfg.strikeVal : autoK;
      notl = (p.compound ? cash + inv * S : p.facility) / K;
      const pv = putPV(S, K, Texp, p.iv, p.rfr) * notl;
      pvTotal += pv;
      entry = { type: "PUT", K, notl, spotEntry: S, pv };
      trade(notl * hedgeFrac(S, K, Texp, p.iv));
    } else {
      // Long CALL at the ITM put's strike (unless overridden). By parity,
      // inherited tokens + free option at K == long call at K + cash K:
      // the book is long the option, so its PV is positive, and the combined
      // delta target is notl * N(-d1) — the same formula as the put phase,
      // just with the strike carried instead of re-struck.
      if (cfg.strikeMode === "manual" && cfg.strikeVal > 0) K = cfg.strikeVal;
      notl = inv;
      const pv = callPV(S, K, Texp, p.iv, p.rfr) * notl;
      pvTotal += pv;
      entry = { type: "CALL", K, notl, spotEntry: S, pv };
      trade(notl * hedgeFrac(S, K, Texp, p.iv));
    }
    anchorS = S;
  };

  startQuarter(0);
  if (!light) daily.push({ d: 0, S, K, cash, tok: inv, invVal: inv * S, total: cash + inv * S });

  for (let i = 1; i <= N; i++) {
    let u = 0, v = 0;
    while (!u) u = rng();
    while (!v) v = rng();
    const Z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    S *= Math.exp((p.mu - 0.5 * p.rv * p.rv) * dt + sq * Z);

    const el = ((i - 1) % RL) + 1;
    const isExpiry = el === RL;

    if (isExpiry) {
      if (mode === "PUT") {
        const itm = S < K;
        trade(itm ? notl : 0); // pin: |delta| -> 1 ITM, 0 OTM
        let payoff = 0, outcome;
        if (itm && !p.itmToCall) {
          payoff = (K - S) * notl;
          cash += notl * K; // deliver the notional at the strike
          inv -= notl;
          if (cash < minCash) minCash = cash;
          outcome = "delivered @ K";
        } else if (itm) {
          outcome = "ITM · kept";
        } else {
          outcome = "OTM · expired";
        }
        if (!light) rolls.push({ ...entry, exit: S, itm, payoff, outcome, token: inv, usdt: cash });
        if (i < N) {
          mode = itm && p.itmToCall ? "CALL" : "PUT";
          rollIdx += 1;
          startQuarter(rollIdx);
        }
      } else {
        // call expiry: inventory has been scalped along N(-d1) all quarter,
        // so the pin is just the terminal delta — no separate assignment leg
        const exited = S >= K;
        trade(exited ? 0 : notl);
        const outcome = exited ? "exited ≥ K" : "holding";
        if (!light) rolls.push({ ...entry, exit: S, itm: exited, payoff: 0, outcome, token: inv, usdt: cash });
        if (i < N) {
          mode = exited ? "PUT" : "CALL";
          rollIdx += 1;
          startQuarter(rollIdx);
        }
      }
    } else if (Math.abs(S / anchorS - 1) >= p.dist) {
      const T = (RL - el) / (365 * spd);
      trade(notl * hedgeFrac(S, K, T, p.iv));
      anchorS = S;
    }

    if (!light && i % spd === 0) daily.push({ d: i / spd, S, K, cash, tok: inv, invVal: inv * S, total: cash + inv * S });
  }

  const totalValue = cash + inv * S;

  // ---- year-end settlement with the client ----
  // The loan can be repaid in kind: tokens count at the strike in force
  // (the exercised put's K). Year end always lands on an expiry, so holding
  // inventory means the final option ended below K — delivery IS the exercise.
  const holding = inv > 1e-9;
  const tokensDelivered = holding ? Math.min(inv, p.facility / K) : 0;
  const tokensKept = inv - tokensDelivered;
  const usdtRepaid = Math.max(0, p.facility - tokensDelivered * K);
  const deskUsdt = cash - usdtRepaid;
  const settlePnl = deskUsdt + tokensKept * S;   // desk economics after settlement
  const clientValue = usdtRepaid + tokensDelivered * S; // market value client receives

  return {
    tokenLeft: inv, usdtLeft: cash, totalValue,
    pnl: totalValue - p.facility, // mark-to-market at spot (no delivery right)
    settlePnl, tokensDelivered, tokensKept, usdtRepaid, deskUsdt, clientValue,
    Kend: K,
    turnover: turn, fees, minCash, nTrades, daily, rolls, pvTotal,
    Sfinal: S,
  };
}

/* ================= monte carlo ================= */

const MC_PATHS = 250;

function monteCarlo(p) {
  const out = [];
  for (let k = 0; k < MC_PATHS; k++) {
    const r = simulate({ ...p, seed: (p.seed + 7919 * (k + 1)) | 0 }, true);
    out.push({ pnl: r.settlePnl, token: r.tokenLeft, fees: r.fees, minCash: r.minCash, pv: r.pvTotal });
  }
  out.sort((a, b) => a.pnl - b.pnl);
  const q = (f) => out[Math.min(out.length - 1, Math.floor(f * out.length))].pnl;
  const mean = out.reduce((a, x) => a + x.pnl, 0) / out.length;
  const meanPV = out.reduce((a, x) => a + x.pv, 0) / out.length;
  const meanFees = out.reduce((a, x) => a + x.fees, 0) / out.length;
  const pctNegCash = out.filter((x) => x.minCash < 0).length / out.length;
  const pctLoss = out.filter((x) => x.pnl < 0).length / out.length;
  const pctHolding = out.filter((x) => x.token > 1).length / out.length;

  const lo = out[0].pnl, hi = out[out.length - 1].pnl;
  const nb = 24, w = (hi - lo) / nb || 1;
  const bins = Array.from({ length: nb }, (_, i) => ({ x: lo + (i + 0.5) * w, n: 0 }));
  out.forEach((x) => {
    const b = Math.min(nb - 1, Math.max(0, Math.floor((x.pnl - lo) / w)));
    bins[b].n += 1;
  });

  return { p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95), mean, meanPV, meanFees, pctNegCash, pctLoss, pctHolding, bins };
}

// heavy run for the Monte Carlo page: full settlement statistics
function statsOf(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return {
    min: s[0], max: s[s.length - 1],
    p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95),
    mean: s.reduce((a, x) => a + x, 0) / s.length,
  };
}

function bigMonteCarlo(p, nSims) {
  const out = [];
  for (let k = 0; k < nSims; k++) {
    const r = simulate({ ...p, seed: (p.seed + 104729 * (k + 1)) | 0 }, true);
    out.push({
      pnl: r.settlePnl, usdtRepaid: r.usdtRepaid, tokDel: r.tokensDelivered,
      clientValue: r.clientValue, minCash: r.minCash, fees: r.fees, pv: r.pvTotal,
      Kend: r.Kend, Sfinal: r.Sfinal,
    });
  }
  const pnl = statsOf(out.map((x) => x.pnl));
  const usdtRepaid = statsOf(out.map((x) => x.usdtRepaid));
  const clientValue = statsOf(out.map((x) => x.clientValue));
  const inKind = out.filter((x) => x.tokDel > 1);
  const tokAll = statsOf(out.map((x) => x.tokDel)); // unconditional, includes the 0s
  const tokDel = inKind.length ? statsOf(inKind.map((x) => x.tokDel)) : null;
  const kindMkt = inKind.length ? statsOf(inKind.map((x) => x.clientValue - x.usdtRepaid)) : null;
  const pctFullUsdt = out.filter((x) => x.usdtRepaid >= p.facility - 1).length / out.length;
  const pctFullKind = out.filter((x) => x.usdtRepaid <= 1).length / out.length;
  const pctPartial = Math.max(0, 1 - pctFullUsdt - pctFullKind);
  const pctInKind = inKind.length / out.length;
  const pctLoss = out.filter((x) => x.pnl < 0).length / out.length;
  const pctNegCash = out.filter((x) => x.minCash < 0).length / out.length;
  const meanFees = out.reduce((a, x) => a + x.fees, 0) / out.length;
  const meanPV = out.reduce((a, x) => a + x.pv, 0) / out.length;

  const lo = pnl.min, hi = pnl.max;
  const nb = 30, w = (hi - lo) / nb || 1;
  const bins = Array.from({ length: nb }, (_, i) => ({ x: lo + (i + 0.5) * w, pct: 0 }));
  out.forEach((x) => {
    const b = Math.min(nb - 1, Math.max(0, Math.floor((x.pnl - lo) / w)));
    bins[b].pct += 100 / out.length;
  });

  // extreme repayment scenarios (fund distribution back to the client)
  const maxTokPath = out.reduce((a, x) => (x.tokDel > a.tokDel ? x : a), out[0]);
  const minKindPath = inKind.length ? inKind.reduce((a, x) => (x.tokDel < a.tokDel ? x : a), inKind[0]) : null;
  const anyFlat = out.some((x) => x.tokDel <= 1);

  return { n: out.length, pnl, usdtRepaid, clientValue, tokAll, tokDel, kindMkt, pctInKind, pctFullUsdt, pctFullKind, pctPartial, pctLoss, pctNegCash, meanFees, meanPV, bins, maxTokPath, minKindPath, anyFlat };
}

/* ================= format ================= */

const fmtUSD = (x, d = 0) =>
  x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }) + " $";
const fmtNum = (x, d = 0) =>
  x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtPx = (x) => x.toLocaleString("en-US", { maximumFractionDigits: 5, minimumFractionDigits: 4 });
const fmtM = (x) => {
  if (Math.abs(x) < 1e-6) x = 0;
  const a = Math.abs(x);
  if (a >= 1e9) return (x / 1e9).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "B";
  if (a >= 1e6) return (x / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "M";
  if (a >= 1e3) return (x / 1e3).toLocaleString("en-US", { maximumFractionDigits: 1 }) + "k";
  return fmtNum(x);
};

/* ================= theme ================= */

const C = {
  bg: "#0D1220", panel: "#151C2C", panel2: "#1A2338", line: "#27324B",
  ink: "#E9EDF5", sub: "#8B95AB",
  blue: "#5B8CFF", token: "#B79BFF", usdt: "#34D3A6",
  warn: "#F5A623", warnBg: "rgba(245,166,35,0.10)",
  neg: "#FF6B5E", pos: "#34D3A6",
};

const tooltipStyle = {
  fontFamily: "'IBM Plex Mono', monospace", fontSize: 11,
  background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 6, color: C.ink,
};

/* ================= UI atoms ================= */

function Slider({ label, value, min, max, step, onChange, fmt }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 11.5, color: C.sub, letterSpacing: 0.2 }}>{label}</span>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: C.ink, fontWeight: 600 }}>
          {fmt ? fmt(value) : value}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: C.blue, height: 4 }}
        aria-label={label}
      />
    </div>
  );
}

function Metric({ label, value, sub, color }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8, padding: "12px 14px", minWidth: 0 }}>
      <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.8, color: C.sub, marginBottom: 5 }}>{label}</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 19, fontWeight: 600, color: color || C.ink, lineHeight: 1.15 }}>{value}</div>
      {sub && <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.sub, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function PanelTitle({ children }) {
  return (
    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: C.sub, fontWeight: 600, marginBottom: 10 }}>
      {children}
    </div>
  );
}

/* ================= main ================= */

export default function App() {
  const [facility, setFacility] = useState(10_000_000);
  const [spot, setSpot] = useState(0.05);
  const [offset, setOffset] = useState(0);
  const [iv, setIv] = useState(0.8);
  const [rv, setRv] = useState(0.8);
  const [mu, setMu] = useState(0);
  const [rfr, setRfr] = useState(0.05);
  const [dist, setDist] = useState(0.005);
  const [costBps, setCostBps] = useState(-0.4);
  const [compound, setCompound] = useState(false);
  const [itmToCall, setItmToCall] = useState(true);
  const [capOn, setCapOn] = useState(false);
  const [capPct, setCapPct] = useState(1.0);
  const [seed, setSeed] = useState(42);

  const [rollCfg, setRollCfg] = useState([
    { spotMode: "auto", spotVal: 0.05, strikeMode: "auto", strikeVal: 0.05 },
    { spotMode: "auto", spotVal: 0.05, strikeMode: "auto", strikeVal: 0.05 },
    { spotMode: "auto", spotVal: 0.05, strikeMode: "auto", strikeVal: 0.05 },
    { spotMode: "auto", spotVal: 0.05, strikeMode: "auto", strikeVal: 0.05 },
  ]);
  const setRoll = (i, patch) =>
    setRollCfg((c) => c.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const params = { facility, spot, offset, iv, rv, mu, rfr, dist, costBps, compound, itmToCall, capOn, capPct, seed, rollCfg };

  const res = useMemo(() => simulate(params), [facility, spot, offset, iv, rv, mu, rfr, dist, costBps, compound, itmToCall, capOn, capPct, seed, rollCfg]);
  const mc = useMemo(() => monteCarlo(params), [facility, spot, offset, iv, rv, mu, rfr, dist, costBps, compound, itmToCall, capOn, capPct, seed, rollCfg]);

  const pnlPct = (res.settlePnl / facility) * 100;

  // pages + heavy Monte Carlo
  const [page, setPage] = useState("dash");
  const [nSims, setNSims] = useState(2000);
  const [big, setBig] = useState(null);
  const [running, setRunning] = useState(false);
  const paramsKey = JSON.stringify(params);
  const runBig = () => {
    setRunning(true);
    setTimeout(() => {
      setBig({ result: bigMonteCarlo(params, nSims), n: nSims, key: paramsKey });
      setRunning(false);
    }, 30);
  };

  const Tab = ({ id, children }) => (
    <button onClick={() => setPage(id)} style={{
      padding: "7px 16px", fontSize: 12.5, fontWeight: page === id ? 700 : 500,
      borderRadius: 7, cursor: "pointer",
      border: `1px solid ${page === id ? C.blue : C.line}`,
      background: page === id ? C.blue : "transparent",
      color: page === id ? "#0D1220" : C.sub,
    }}>
      {children}
    </button>
  );

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.ink, fontFamily: "'Archivo', system-ui, sans-serif", padding: "20px 16px 48px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        table{ border-collapse:collapse; }
        .layout{ display:grid; grid-template-columns:280px 1fr; gap:16px; align-items:start; }
        @media (max-width: 780px){ .layout{ grid-template-columns:1fr; } }
        button:focus-visible, input:focus-visible{ outline:2px solid ${C.blue}; outline-offset:2px; }
        @media (prefers-reduced-motion: reduce){ *{ transition:none!important; } }
      `}</style>

      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
          <h1 style={{ fontSize: 21, fontWeight: 700, margin: 0, letterSpacing: -0.3 }}>Long put, delta-hedged · grid bot</h1>
          <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.blue, border: `1px solid ${C.blue}`, borderRadius: 4, padding: "2px 7px" }}>
            quarterly free options · ITM puts roll into calls
          </span>
        </div>
        <p style={{ color: C.sub, fontSize: 12.5, margin: "0 0 18px", maxWidth: 760, lineHeight: 1.5 }}>
          The client lends the desk {fmtM(facility)} USDT. Each quarter the desk holds a free 90-day option
          and grid-hedges its delta in spot. Puts: buy as price falls, sell as it rises. An ITM put leaves the
          book holding the full notional; the next quarter is a long call at that put's strike, hedged with the
          same grid (target N(−d1) × notional), selling the inventory as price climbs back through K.
          Net P&amp;L is measured against repaying the loan.
        </p>

        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          <Tab id="dash">Dashboard</Tab>
          <Tab id="mc">Monte Carlo</Tab>
        </div>

        {page === "dash" && (<>

        {res.minCash < 0 && (
          <div style={{ background: C.warnBg, border: `1px solid ${C.warn}`, color: C.warn, borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 16, fontWeight: 500 }}>
            Funding constraint on this path: USDT cash dips below zero (min {fmtUSD(res.minCash)}).
          </div>
        )}

        {/* headline — this path */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginBottom: 18 }}>
          <Metric label="USDT at year end" value={fmtUSD(res.usdtLeft)} color={C.usdt} />
          <Metric label="TOKEN at year end" value={fmtM(res.tokenLeft)} sub={res.tokenLeft > 1 ? `× ${fmtPx(res.Sfinal)} = ${fmtUSD(res.tokenLeft * res.Sfinal)}` : "book is flat"} color={C.token} />
          <Metric label="Total value" value={fmtUSD(res.totalValue)} />
          <Metric label="Net P&L (after settlement)" value={`${res.settlePnl >= 0 ? "+" : ""}${fmtUSD(res.settlePnl)}`} sub={`${pnlPct >= 0 ? "+" : ""}${fmtNum(pnlPct, 2)} % · mtm ${fmtM(res.pnl)} $`} color={res.settlePnl >= 0 ? C.pos : C.neg} />
          <Metric label="PV of options" value={fmtUSD(res.pvTotal)} sub="all held long · expected gross" color={C.ink} />
          <Metric label="Turnover / fees" value={fmtM(res.turnover) + " $"} sub={`fees ${fmtUSD(res.fees)} · ${fmtNum(res.nTrades)} trades`} />
        </div>

        {/* client settlement — this path */}
        <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "14px 14px 12px", marginBottom: 18 }}>
          <PanelTitle>Year-end settlement — what goes back to the client (this path)</PanelTitle>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
            <Metric label="USDT repaid" value={fmtUSD(res.usdtRepaid)} color={C.usdt} />
            <Metric
              label="TOKEN delivered"
              value={res.tokensDelivered > 1 ? fmtM(res.tokensDelivered) : "—"}
              sub={res.tokensDelivered > 1 ? `face @ K = ${fmtM(res.tokensDelivered * res.Kend)} $ · mkt ${fmtM(res.tokensDelivered * res.Sfinal)} $` : "loan fully repaid in USDT"}
              color={C.token}
            />
            <Metric
              label="Client receives (market)"
              value={fmtUSD(res.clientValue)}
              sub={res.clientValue < facility ? `shortfall ${fmtUSD(facility - res.clientValue)} vs loan` : "full value"}
              color={res.clientValue < facility ? C.warn : C.usdt}
            />
            <Metric
              label="Desk keeps"
              value={fmtUSD(res.deskUsdt)}
              sub={res.tokensKept > 1 ? `+ ${fmtM(res.tokensKept)} TOKEN = ${fmtM(res.tokensKept * res.Sfinal)} $` : "USDT only"}
              color={res.deskUsdt >= 0 ? C.pos : C.neg}
            />
          </div>
          <p style={{ fontSize: 11, color: C.sub, margin: "10px 0 0", lineHeight: 1.5 }}>
            Tokens repay the loan in kind at the strike in force (the exercised put's K), not at spot — that delivery right
            is the put. The client's shortfall vs the loan face equals delivered × (K − S): the client bears the downside
            below strike, which is exactly what the facility grants the desk.
          </p>
        </div>

        <div className="layout">
          {/* params */}
          <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16 }}>
            <PanelTitle>Parameters</PanelTitle>
            <Slider label="Loan size (USDT)" value={facility} min={500000} max={20000000} step={250000} onChange={setFacility} fmt={(v) => fmtM(v) + " $"} />
            <Slider label="Starting spot" value={spot} min={0.01} max={0.2} step={0.001} onChange={setSpot} fmt={fmtPx} />
            <Slider label="Strike offset (puts)" value={offset} min={-0.3} max={0.1} step={0.01} onChange={setOffset} fmt={(v) => fmtNum(v * 100, 0) + " %"} />
            <Slider label="Implied vol (delta + PV)" value={iv} min={0.3} max={1.5} step={0.05} onChange={setIv} fmt={(v) => fmtNum(v * 100, 0) + " %"} />
            <div style={{ fontSize: 11, color: C.sub, margin: "-8px 0 14px", lineHeight: 1.4 }}>
              No listed option exists, so this is the vol the desk marks the options at — it drives the delta targets and the PVs.
            </div>
            <Slider label="Realised vol (path)" value={rv} min={0} max={1.8} step={0.05} onChange={setRv} fmt={(v) => (v === 0 ? "0 % (deterministic)" : fmtNum(v * 100, 0) + " %")} />
            <Slider label="Annual drift" value={mu} min={-0.7} max={1} step={0.05} onChange={setMu} fmt={(v) => fmtNum(v * 100, 0) + " %"} />
            <Slider label="Risk-free rate (PV)" value={rfr} min={0} max={0.15} step={0.005} onChange={setRfr} fmt={(v) => fmtNum(v * 100, 1) + " %"} />
            <Slider label="Rehedge distance (grid step)" value={dist} min={0.0025} max={0.1} step={0.0025} onChange={setDist} fmt={(v) => fmtNum(v * 100, 2) + " %"} />
            <div style={{ fontSize: 11, color: C.sub, margin: "-8px 0 14px", lineHeight: 1.4 }}>
              Rebalance to Δ(S, T) only when spot has moved this far from the last hedge point — fill-triggered, like the grid bot.
            </div>
            <Slider label="Execution cost (neg = maker)" value={costBps} min={-10} max={25} step={0.1} onChange={setCostBps} fmt={(v) => fmtNum(v, 1) + " bps"} />

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.ink, marginBottom: 10, cursor: "pointer" }}>
              <input type="checkbox" checked={itmToCall} onChange={(e) => setItmToCall(e.target.checked)} style={{ accentColor: C.blue }} />
              Roll ITM puts into covered calls
            </label>
            <div style={{ fontSize: 11, color: C.sub, margin: "-4px 0 14px", lineHeight: 1.4 }}>
              Off: ITM puts deliver the notional at the strike instead (loan tranche repaid in kind).
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.ink, marginBottom: 10, cursor: "pointer" }}>
              <input type="checkbox" checked={capOn} onChange={(e) => setCapOn(e.target.checked)} style={{ accentColor: C.blue }} />
              Cap put strikes
            </label>
            {capOn && (<>
              <Slider label="Strike cap (% of start)" value={capPct} min={0} max={2} step={0.05} onChange={setCapPct} fmt={(v) => fmtNum(v * 100, 0) + " %"} />
              <div style={{ fontSize: 11, color: C.sub, margin: "-8px 0 14px", lineHeight: 1.4 }}>
                {capPct > 0 ? <>Puts never strike above {fmtPx(spot * capPct)} ({fmtNum(capPct * 100, 0)} % of start), so an in-kind tranche always delivers at least
                {" "}{fmtM(facility / (spot * capPct))} TOKEN ({fmtM(facility)} $ / {fmtPx(spot * capPct)}). Manual strike overrides bypass the cap.</> : <>0 % = cap inactive (a strike can't be zero). Slide up to set a ceiling.</>}
              </div>
            </>)}

            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.ink, marginBottom: 14, cursor: "pointer" }}>
              <input type="checkbox" checked={compound} onChange={(e) => setCompound(e.target.checked)} style={{ accentColor: C.blue }} />
              Compound notional (resize on total value)
            </label>

            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11.5, color: C.sub, marginBottom: 6 }}>Seed (copy / paste to reproduce a sim)</div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="text" inputMode="numeric" value={seed}
                  onChange={(e) => { const v = parseInt(e.target.value, 10); if (Number.isFinite(v)) setSeed(v); }}
                  style={{ flex: 1, minWidth: 0, fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", padding: "7px 9px", border: `1px solid ${C.line}`, borderRadius: 6, background: C.panel2, color: C.ink }}
                  aria-label="Seed"
                />
                <button
                  onClick={() => { try { navigator.clipboard.writeText(String(seed)); } catch (e) { /* input is selectable as fallback */ } }}
                  style={{ padding: "7px 12px", fontSize: 12, border: `1px solid ${C.line}`, borderRadius: 6, background: "transparent", color: C.sub, cursor: "pointer" }}
                >
                  Copy
                </button>
              </div>
            </div>
            <button
              onClick={() => setSeed(Math.floor(Math.random() * 1e9))}
              style={{ width: "100%", padding: "9px 0", background: C.ink, color: C.bg, border: "none", borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: "pointer" }}
            >
              New path (random seed)
            </button>
          </div>

          {/* right column */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>

            {/* per-quarter overrides */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 10 }}>
              {rollCfg.map((cfg, i) => {
                const r = res.rolls[i];
                const isCall = r?.type === "CALL";
                const OvRow = ({ label, mode, val, onMode, onVal, autoText, disabled }) => (
                  <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 5, opacity: disabled ? 0.45 : 1 }}>
                    <span style={{ fontSize: 10.5, color: C.sub, width: 38 }}>{label}</span>
                    <button onClick={disabled ? undefined : onMode} style={{
                      fontSize: 10, padding: "2px 6px", borderRadius: 4, cursor: disabled ? "default" : "pointer",
                      border: `1px solid ${mode === "manual" ? C.blue : C.line}`,
                      background: mode === "manual" ? C.blue : "transparent",
                      color: mode === "manual" ? "#0D1220" : C.sub,
                      fontFamily: "'IBM Plex Mono', monospace",
                    }}>
                      {mode === "auto" ? "auto" : "manual"}
                    </button>
                    {mode === "manual" && !disabled ? (
                      <input
                        type="number" step="0.001" value={val}
                        onChange={(e) => onVal(parseFloat(e.target.value) || 0)}
                        style={{ width: 68, fontSize: 11, padding: "2px 5px", border: `1px solid ${C.line}`, borderRadius: 4, background: C.panel2, color: C.ink }}
                        aria-label={`${label} Q${i + 1}`}
                      />
                    ) : (
                      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: C.ink }}>{autoText}</span>
                    )}
                  </div>
                );
                return (
                  <div key={i} style={{ background: C.panel, border: `1px solid ${C.line}`, borderTop: `3px solid ${isCall ? C.token : C.blue}`, borderRadius: 8, padding: "10px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: isCall ? C.token : C.blue }}>
                        {r ? r.type : "PUT"} Q{i + 1}
                      </span>
                      {r && (
                        <span style={{ fontSize: 9.5, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: r.token > 1 ? C.token : C.usdt, color: "#0D1220", alignSelf: "center" }}>
                          {r.outcome}
                        </span>
                      )}
                    </div>
                    <OvRow
                      label="entry" mode={cfg.spotMode} val={cfg.spotVal}
                      onMode={() => setRoll(i, { spotMode: cfg.spotMode === "auto" ? "manual" : "auto", spotVal: r ? r.spotEntry : spot })}
                      onVal={(v) => setRoll(i, { spotVal: v })}
                      autoText={isCall ? `${fmtPx(r.spotEntry)} (holding)` : i === 0 ? `${fmtPx(spot)} (start)` : r ? fmtPx(r.spotEntry) : "realised"}
                      disabled={isCall}
                    />
                    <OvRow
                      label="strike" mode={cfg.strikeMode} val={cfg.strikeVal}
                      onMode={() => setRoll(i, { strikeMode: cfg.strikeMode === "auto" ? "manual" : "auto", strikeVal: r ? r.K : spot })}
                      onVal={(v) => setRoll(i, { strikeVal: v })}
                      autoText={r ? (isCall ? `${fmtPx(r.K)} (put K)` : `${fmtPx(r.K)} (${fmtNum(offset * 100, 0)}%)`) : "spot×(1+off)"}
                    />
                    {r && (
                      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, lineHeight: 1.7, marginTop: 4 }}>
                        <div><span style={{ color: C.sub }}>PV</span> <span style={{ color: r.pv >= 0 ? C.blue : C.neg }}>{fmtM(r.pv)} $</span> · <span style={{ color: C.sub }}>exit</span> {fmtPx(r.exit)}</div>
                        <div><span style={{ color: C.sub }}>USDT after</span> <span style={{ color: C.usdt }}>{fmtM(r.usdt)} $</span>{r.token > 1 && <> · <span style={{ color: C.sub }}>TOKEN</span> <span style={{ color: C.token }}>{fmtM(r.token)} = {fmtM(r.token * r.exit)} $</span></>}</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p style={{ fontSize: 11, color: C.sub, margin: "-6px 2px 0", lineHeight: 1.4 }}>
              Quarter types are path-dependent: an ITM put makes the next quarter a long call at the put's strike;
              once the inventory is sold out above K, quarters flip back to puts. Manual entry spot restarts the path
              at the boundary (only when the book is flat — disabled on call quarters). Manual strike overrides the
              default (puts: spot × (1 + offset); calls: previous put's K).
            </p>

            {/* chart 1 */}
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "14px 10px 6px" }}>
              <div style={{ margin: "0 8px" }}><PanelTitle>Spot &amp; active strike — this path</PanelTitle></div>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={res.daily} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={C.line} strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="d" tick={{ fontSize: 10, fill: C.sub }} tickLine={false} axisLine={{ stroke: C.line }} ticks={[0, 90, 180, 270, 360]} />
                  <YAxis tick={{ fontSize: 10, fill: C.sub }} tickLine={false} axisLine={false} domain={["auto", "auto"]} tickFormatter={(v) => v.toFixed(3)} width={48} />
                  <Tooltip formatter={(v, n) => [fmtPx(v), n === "S" ? "Spot" : "Strike"]} labelFormatter={(d) => `Day ${d}`} contentStyle={tooltipStyle} />
                  {[90, 180, 270].map((d) => <ReferenceLine key={d} x={d} stroke={C.line} />)}
                  <Line dataKey="S" stroke={C.ink} dot={false} strokeWidth={1.6} name="S" isAnimationActive={false} />
                  <Line dataKey="K" stroke={C.blue} dot={false} strokeWidth={1.4} strokeDasharray="5 4" type="stepAfter" name="K" isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* chart 2 */}
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "14px 10px 6px" }}>
              <div style={{ margin: "0 8px" }}><PanelTitle>Balances — USDT cash, TOKEN inventory, total</PanelTitle></div>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={res.daily} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={C.line} strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="d" tick={{ fontSize: 10, fill: C.sub }} tickLine={false} axisLine={{ stroke: C.line }} ticks={[0, 90, 180, 270, 360]} />
                  <YAxis tick={{ fontSize: 10, fill: C.sub }} tickLine={false} axisLine={false} tickFormatter={fmtM} width={52} />
                  <Tooltip
                    formatter={(v, n, pr) => {
                      if (n === "invVal") return [`${fmtM(pr.payload.tok)} TOKEN = ${fmtUSD(v)}`, "TOKEN inventory"];
                      return [fmtUSD(v), n === "cash" ? "USDT cash" : "Total value"];
                    }}
                    labelFormatter={(d) => `Day ${d}`} contentStyle={tooltipStyle}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <ReferenceLine y={0} stroke={C.neg} strokeDasharray="3 3" />
                  <ReferenceLine y={facility} stroke={C.sub} strokeDasharray="3 3" />
                  {[90, 180, 270].map((d) => <ReferenceLine key={d} x={d} stroke={C.line} />)}
                  <Line dataKey="cash" stroke={C.usdt} dot={false} strokeWidth={1.5} name="cash" isAnimationActive={false} />
                  <Line dataKey="invVal" stroke={C.token} dot={false} strokeWidth={1.5} name="invVal" isAnimationActive={false} />
                  <Line dataKey="total" stroke={C.ink} dot={false} strokeWidth={1.8} name="total" isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* roll table */}
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "14px 14px 10px", overflowX: "auto" }}>
              <PanelTitle>Quarter detail — this path</PanelTitle>
              <table style={{ width: "100%", fontSize: 12, fontFamily: "'IBM Plex Mono', monospace" }}>
                <thead>
                  <tr style={{ color: C.sub, textAlign: "right" }}>
                    <th style={{ textAlign: "left", padding: "4px 8px 8px 0", fontWeight: 500 }}>Q</th>
                    <th style={{ padding: "4px 8px 8px", fontWeight: 500 }}>Type</th>
                    <th style={{ padding: "4px 8px 8px", fontWeight: 500 }}>Entry spot</th>
                    <th style={{ padding: "4px 8px 8px", fontWeight: 500 }}>Strike</th>
                    <th style={{ padding: "4px 8px 8px", fontWeight: 500 }}>Notional</th>
                    <th style={{ padding: "4px 8px 8px", fontWeight: 500 }}>PV</th>
                    <th style={{ padding: "4px 8px 8px", fontWeight: 500 }}>Exit spot</th>
                    <th style={{ padding: "4px 8px 8px", fontWeight: 500 }}>Outcome</th>
                    <th style={{ padding: "4px 8px 8px", fontWeight: 500 }}>TOKEN after</th>
                    <th style={{ padding: "4px 0 8px 8px", fontWeight: 500 }}>USDT after</th>
                  </tr>
                </thead>
                <tbody>
                  {res.rolls.map((r, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${C.line}`, textAlign: "right" }}>
                      <td style={{ textAlign: "left", padding: "7px 8px 7px 0", fontWeight: 600 }}>{i + 1}</td>
                      <td style={{ padding: "7px 8px", color: r.type === "PUT" ? C.blue : C.token, fontWeight: 600 }}>{r.type}</td>
                      <td style={{ padding: "7px 8px" }}>{fmtPx(r.spotEntry)}</td>
                      <td style={{ padding: "7px 8px" }}>{fmtPx(r.K)}</td>
                      <td style={{ padding: "7px 8px" }}>{fmtM(r.notl)} <span style={{ color: C.sub }}>= {fmtM(r.notl * r.K)} $ @K</span></td>
                      <td style={{ padding: "7px 8px", color: r.pv >= 0 ? C.blue : C.neg }}>{fmtUSD(r.pv)}</td>
                      <td style={{ padding: "7px 8px" }}>{fmtPx(r.exit)}</td>
                      <td style={{ padding: "7px 8px" }}>
                        <span style={{ fontSize: 9.5, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: r.token > 1 ? C.token : C.usdt, color: "#0D1220" }}>
                          {r.outcome}
                        </span>
                      </td>
                      <td style={{ padding: "7px 8px", color: C.token }}>{r.token > 1 ? <>{fmtM(r.token)} <span style={{ color: C.sub }}>= {fmtM(r.token * r.exit)} $</span></> : "—"}</td>
                      <td style={{ padding: "7px 0 7px 8px", color: C.usdt }}>{fmtUSD(r.usdt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: 11, color: C.sub, margin: "10px 0 2px", lineHeight: 1.5 }}>
                All options are held long (granted free through the facility), so every PV is positive value received.
                Call quarters hedge with the same grid and the same target formula, N(−d1) × notional, with the strike
                carried from the ITM put: inventory is sold progressively as price climbs through K and bought back on
                dips — same scalping, opposite journey. If price never recovers above K, the quarter ends still holding.
              </p>
            </div>

            {/* monte carlo */}
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "14px 14px 10px" }}>
              <PanelTitle>Quick look across {MC_PATHS} paths — desk P&amp;L after settlement</PanelTitle>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8, marginBottom: 12 }}>
                <Metric label="P5" value={fmtM(mc.p5) + " $"} color={mc.p5 >= 0 ? C.pos : C.neg} />
                <Metric label="P25" value={fmtM(mc.p25) + " $"} color={mc.p25 >= 0 ? C.pos : C.neg} />
                <Metric label="Median" value={fmtM(mc.p50) + " $"} color={mc.p50 >= 0 ? C.pos : C.neg} />
                <Metric label="P75" value={fmtM(mc.p75) + " $"} color={mc.p75 >= 0 ? C.pos : C.neg} />
                <Metric label="P95" value={fmtM(mc.p95) + " $"} color={mc.p95 >= 0 ? C.pos : C.neg} />
                <Metric label="Mean" value={fmtM(mc.mean) + " $"} sub={`vs mean net PV ${fmtM(mc.meanPV)} $`} color={mc.mean >= 0 ? C.pos : C.neg} />
              </div>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={mc.bins} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={C.line} strokeDasharray="2 4" vertical={false} />
                  <XAxis dataKey="x" tick={{ fontSize: 10, fill: C.sub }} tickLine={false} axisLine={{ stroke: C.line }} tickFormatter={fmtM} />
                  <YAxis tick={{ fontSize: 10, fill: C.sub }} tickLine={false} axisLine={false} width={30} allowDecimals={false} />
                  <Tooltip formatter={(v) => [v + " paths", "count"]} labelFormatter={(x) => `P&L ≈ ${fmtM(x)} $`} contentStyle={tooltipStyle} />
                  <ReferenceLine x={0} stroke={C.neg} />
                  <Bar dataKey="n" fill={C.blue} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
              <p style={{ fontSize: 11, color: C.sub, margin: "10px 0 2px", lineHeight: 1.5 }}>
                Same parameters, {MC_PATHS} independent paths (stepped at 24/d here vs {PATH_SPD}/d for the displayed path).
                Losing paths: {fmtNum(mc.pctLoss * 100, 0)} % · negative-cash paths: {fmtNum(mc.pctNegCash * 100, 0)} % ·
                still holding TOKEN at year end: {fmtNum(mc.pctHolding * 100, 0)} % · mean fees {fmtUSD(mc.meanFees)}.
                Mean P&amp;L should track the mean PV of the options minus fee drag. The left tail is paths that end the
                year still holding inventory below the carried strike, marked at spot.
              </p>
            </div>
          </div>
        </div>
        </>)}

        {page === "mc" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16 }}>
              <PanelTitle>Run</PanelTitle>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 12, color: C.sub }}>Simulations:</span>
                {[500, 1000, 2000, 5000].map((n) => (
                  <button key={n} onClick={() => setNSims(n)} style={{
                    padding: "5px 12px", fontSize: 11.5, fontFamily: "'IBM Plex Mono', monospace",
                    borderRadius: 5, cursor: "pointer",
                    border: `1px solid ${nSims === n ? C.blue : C.line}`,
                    background: nSims === n ? C.blue : "transparent",
                    color: nSims === n ? "#0D1220" : C.sub, fontWeight: nSims === n ? 700 : 400,
                  }}>
                    {fmtNum(n)}
                  </button>
                ))}
                <button onClick={runBig} disabled={running} style={{
                  padding: "7px 22px", background: running ? C.line : C.ink, color: running ? C.sub : C.bg,
                  border: "none", borderRadius: 7, fontSize: 13, fontWeight: 700, cursor: running ? "default" : "pointer",
                }}>
                  {running ? "Running…" : "Run"}
                </button>
                <span style={{ fontSize: 11.5, color: C.sub }}>
                  Uses the parameters currently set on the Dashboard page (paths stepped at 24/d).
                </span>
              </div>
            </div>

            {big && big.key !== paramsKey && (
              <div style={{ background: C.warnBg, border: `1px solid ${C.warn}`, color: C.warn, borderRadius: 8, padding: "10px 14px", fontSize: 13, fontWeight: 500 }}>
                Parameters (or seed) changed since this run — the results below are stale. Hit Run to recompute.
              </div>
            )}

            {big && (<>
              <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "14px 14px 10px" }}>
                <PanelTitle>Desk P&L after settlement — {fmtNum(big.result.n)} paths</PanelTitle>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(115px, 1fr))", gap: 8, marginBottom: 12 }}>
                  <Metric label="Worst" value={fmtM(big.result.pnl.min) + " $"} color={C.neg} />
                  <Metric label="P5" value={fmtM(big.result.pnl.p5) + " $"} color={big.result.pnl.p5 >= 0 ? C.pos : C.neg} />
                  <Metric label="P25" value={fmtM(big.result.pnl.p25) + " $"} color={big.result.pnl.p25 >= 0 ? C.pos : C.neg} />
                  <Metric label="Median" value={fmtM(big.result.pnl.p50) + " $"} color={big.result.pnl.p50 >= 0 ? C.pos : C.neg} />
                  <Metric label="P75" value={fmtM(big.result.pnl.p75) + " $"} color={big.result.pnl.p75 >= 0 ? C.pos : C.neg} />
                  <Metric label="P95" value={fmtM(big.result.pnl.p95) + " $"} color={big.result.pnl.p95 >= 0 ? C.pos : C.neg} />
                  <Metric label="Best" value={fmtM(big.result.pnl.max) + " $"} color={C.pos} />
                  <Metric label="Mean" value={fmtM(big.result.pnl.mean) + " $"} sub={`vs mean PV ${fmtM(big.result.meanPV)} $`} color={big.result.pnl.mean >= 0 ? C.pos : C.neg} />
                </div>
                <ResponsiveContainer width="100%" height={190}>
                  <BarChart data={big.result.bins} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={C.line} strokeDasharray="2 4" vertical={false} />
                    <XAxis dataKey="x" tick={{ fontSize: 10, fill: C.sub }} tickLine={false} axisLine={{ stroke: C.line }} tickFormatter={fmtM} />
                    <YAxis tick={{ fontSize: 10, fill: C.sub }} tickLine={false} axisLine={false} width={36} tickFormatter={(v) => v.toFixed(0) + "%"} />
                    <Tooltip formatter={(v) => [v.toFixed(1) + " % of paths", ""]} labelFormatter={(x) => `P&L ≈ ${fmtM(x)} $`} contentStyle={tooltipStyle} />
                    <ReferenceLine x={0} stroke={C.neg} />
                    <Bar dataKey="pct" fill={C.blue} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
                <p style={{ fontSize: 11, color: C.sub, margin: "10px 0 2px", lineHeight: 1.5 }}>
                  Probability of losing money: {fmtNum(big.result.pctLoss * 100, 1)} % · paths hitting negative cash:
                  {" "}{fmtNum(big.result.pctNegCash * 100, 1)} % · mean fees {fmtUSD(big.result.meanFees)}.
                </p>
              </div>

              <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: "14px 14px 10px", overflowX: "auto" }}>
                <PanelTitle>What goes back to the client</PanelTitle>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 12 }}>
                  <Metric label="Face repaid" value={fmtM(facility) + " $"} sub="always — the split is all-or-nothing" color={C.ink} />
                  <Metric label="6M all in USDT" value={fmtNum(big.result.pctFullUsdt * 100, 1) + " %"} sub="of paths — year ends flat" color={C.usdt} />
                  <Metric label="All in TOKEN (face @ K)" value={fmtNum(big.result.pctFullKind * 100, 1) + " %"} sub="of paths — full tranche in-kind" color={C.token} />
                  {big.result.pctPartial > 0.001 && (
                    <Metric label="Mixed split" value={fmtNum(big.result.pctPartial * 100, 1) + " %"} sub="of paths (compounding only)" />
                  )}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginBottom: 12 }}>
                  {big.result.anyFlat && (
                    <Metric
                      label="Least TOKEN sent (best case if you want USDT back)"
                      value="0 TOKEN"
                      sub={`package: ${fmtM(facility)} $ USDT · ${fmtNum(big.result.pctFullUsdt * 100, 0)} % of paths end here`}
                      color={C.usdt}
                    />
                  )}
                  {big.result.minKindPath && (
                    <Metric
                      label="Guaranteed minimum when in-kind"
                      value={fmtM(big.result.minKindPath.tokDel) + " TOKEN"}
                      sub={`package: 0 USDT + tokens @ K ${fmtPx(big.result.minKindPath.Kend)} · mkt ${fmtM(big.result.minKindPath.clientValue)} $`}
                      color={C.token}
                    />
                  )}
                  {big.result.maxTokPath.tokDel > 1 && (
                    <Metric
                      label="Most TOKEN sent (deepest strike path)"
                      value={fmtM(big.result.maxTokPath.tokDel) + " TOKEN"}
                      sub={`package: 0 USDT + tokens @ K ${fmtPx(big.result.maxTokPath.Kend)} · mkt ${fmtM(big.result.maxTokPath.clientValue)} $ at S ${fmtPx(big.result.maxTokPath.Sfinal)}`}
                      color={C.token}
                    />
                  )}
                </div>
                <table style={{ width: "100%", fontSize: 12, fontFamily: "'IBM Plex Mono', monospace" }}>
                  <thead>
                    <tr style={{ color: C.sub, textAlign: "right" }}>
                      <th style={{ textAlign: "left", padding: "4px 8px 8px 0", fontWeight: 500 }}>Outcome</th>
                      <th style={{ padding: "4px 8px 8px", fontWeight: 500 }}>Probability</th>
                      <th style={{ padding: "4px 8px 8px", fontWeight: 500 }}>USDT to client</th>
                      <th style={{ padding: "4px 8px 8px", fontWeight: 500 }}>TOKEN to client</th>
                      <th style={{ padding: "4px 0 8px 8px", fontWeight: 500 }}>Market value received</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ borderTop: `1px solid ${C.line}`, textAlign: "right" }}>
                      <td style={{ textAlign: "left", padding: "7px 8px 7px 0", color: C.usdt }}>Year ends flat — repaid in USDT</td>
                      <td style={{ padding: "7px 8px" }}>{fmtNum(big.result.pctFullUsdt * 100, 1)} %</td>
                      <td style={{ padding: "7px 8px", color: C.usdt }}>{fmtM(facility)} $</td>
                      <td style={{ padding: "7px 8px", color: C.sub }}>0</td>
                      <td style={{ padding: "7px 0 7px 8px" }}>{fmtM(facility)} $ (full)</td>
                    </tr>
                    {big.result.tokDel && (
                      <tr style={{ borderTop: `1px solid ${C.line}`, textAlign: "right" }}>
                        <td style={{ textAlign: "left", padding: "7px 8px 7px 0", color: C.token }}>Repaid in kind — tokens at strike</td>
                        <td style={{ padding: "7px 8px" }}>{fmtNum(big.result.pctFullKind * 100, 1)} %</td>
                        <td style={{ padding: "7px 8px", color: C.sub }}>0</td>
                        <td style={{ padding: "7px 8px", color: C.token }}>
                          {Math.abs(big.result.tokDel.max - big.result.tokDel.min) < 1
                            ? `${fmtM(big.result.tokDel.min)} (always)`
                            : `${fmtM(big.result.tokDel.min)} – ${fmtM(big.result.tokDel.max)} · med ${fmtM(big.result.tokDel.p50)}`}
                        </td>
                        <td style={{ padding: "7px 0 7px 8px" }}>
                          {fmtM(big.result.kindMkt.min)} – {fmtM(big.result.kindMkt.max)} $ · med {fmtM(big.result.kindMkt.p50)} $
                        </td>
                      </tr>
                    )}
                    {big.result.pctPartial > 0.001 && (
                      <tr style={{ borderTop: `1px solid ${C.line}`, textAlign: "right" }}>
                        <td style={{ textAlign: "left", padding: "7px 8px 7px 0" }}>Mixed (compounding only)</td>
                        <td style={{ padding: "7px 8px" }}>{fmtNum(big.result.pctPartial * 100, 1)} %</td>
                        <td style={{ padding: "7px 8px", color: C.sub }} colSpan={3}>USDT + TOKEN summing to {fmtM(facility)} $ at face</td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <p style={{ fontSize: 11, color: C.sub, margin: "10px 0 2px", lineHeight: 1.5 }}>
                  With one option per quarter the tranche is all-or-nothing, so the face split is binary: the client
                  gets {fmtM(facility)} $ entirely in USDT or entirely in TOKEN counted at the strike — the two legs are
                  jointly constrained (0 USDT implies the token floor; full USDT implies 0 TOKEN), which is why outcomes
                  are shown as conditional rows rather than independent columns. The gap between face and market value
                  on the in-kind row is the client's side of the free put. Note: at 0 %
                  drift a GBM path has a −σ²/2 median trend (≈ −32 %/yr at 80 % vol), which is why in-kind outcomes
                  dominate; drift is the assumption this split is most sensitive to.
                </p>
              </div>
            </>)}
          </div>
        )}
      </div>
    </div>
  );
}
