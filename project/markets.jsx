/* global React, Footer */
const { useState, useEffect, useMemo, useRef } = React;

/* ----------------------------------------------------------------
   Shared data + helpers (exposed to app.jsx via window)
   ---------------------------------------------------------------- */

const MARKETS = [
  { tkr: "PEPELON",    chain: "BASE",  pool: "0x4f…a912", prob: 0.83, vol: 4280, bets: 142, ttl: 5 * 3600 + 12 * 60, agents: [0.92, 0.78, 0.81], price: "-12.4%", new: true, hist: [82,79,77,74,68,61,56,51,48] },
  { tkr: "MONA",       chain: "ETH",   pool: "0xb1…7c3e", prob: 0.71, vol: 2940, bets: 88,  ttl: 11 * 3600 + 4 * 60, agents: [0.71, 0.66, 0.78], price: "-3.1%", hist: [99,98,98,97,97,96,95,94,93] },
  { tkr: "WAGMI42",    chain: "BASE",  pool: "0x09…11ab", prob: 0.66, vol: 1820, bets: 61,  ttl: 26 * 3600,         agents: [0.62, 0.58, 0.71], price: "-1.0%", hist: [100,99,99,98,98,97,97,96,99] },
  { tkr: "DEGENPUP",   chain: "ARB",   pool: "0xfa…d010", prob: 0.59, vol: 1260, bets: 44,  ttl: 39 * 3600,         agents: [0.55, 0.41, 0.62], price: "+0.4%", hist: [100,100,101,101,100,100,101,101,100] },
  { tkr: "AIDOG",      chain: "BASE",  pool: "0x77…22fe", prob: 0.41, vol: 920,  bets: 30,  ttl: 64 * 3600,         agents: [0.44, 0.36, 0.41], price: "+2.2%", hist: [100,101,102,102,102,103,102,102,104] },
  { tkr: "TRUTH404",   chain: "SOL",   pool: "9aH…kQ2",   prob: 0.28, vol: 410,  bets: 18,  ttl: 88 * 3600,         agents: [0.31, 0.22, 0.28], price: "+5.1%", hist: [100,101,103,104,103,104,105,104,106] },
  { tkr: "MOONBOY",    chain: "BASE",  pool: "0xae…4471", prob: 0.74, vol: 3120, bets: 96,  ttl: 8 * 3600 + 40 * 60, agents: [0.78, 0.68, 0.73], price: "-6.4%", hist: [98,96,93,90,86,82,77,72,68] },
  { tkr: "VITALIKBOT", chain: "ETH",   pool: "0x5e…d903", prob: 0.62, vol: 2180, bets: 71,  ttl: 18 * 3600,         agents: [0.59, 0.51, 0.66], price: "-2.0%", hist: [100,99,99,98,98,97,96,95,98] },
  { tkr: "GROK10",     chain: "BASE",  pool: "0x12…99ee", prob: 0.55, vol: 1410, bets: 52,  ttl: 31 * 3600,         agents: [0.51, 0.49, 0.58], price: "-0.3%", hist: [100,100,99,99,100,99,99,100,99] },
  { tkr: "SHIBA404",   chain: "ETH",   pool: "0x88…0a01", prob: 0.49, vol: 1020, bets: 38,  ttl: 42 * 3600,         agents: [0.51, 0.42, 0.48], price: "+1.1%", hist: [100,100,101,101,100,101,102,101,101] },
  { tkr: "BASEPILL",   chain: "BASE",  pool: "0x3a…71b2", prob: 0.39, vol: 780,  bets: 25,  ttl: 55 * 3600,         agents: [0.40, 0.31, 0.42], price: "+3.4%", hist: [100,102,101,103,104,103,104,105,104] },
  { tkr: "FROGSWAP",   chain: "ARB",   pool: "0x9b…ff10", prob: 0.31, vol: 540,  bets: 19,  ttl: 71 * 3600,         agents: [0.33, 0.25, 0.32], price: "+4.8%", hist: [100,101,102,103,104,105,105,106,107] },
  { tkr: "GIGACHAD",   chain: "BASE",  pool: "0x71…2bca", prob: 0.69, vol: 2640, bets: 79,  ttl: 14 * 3600,         agents: [0.71, 0.62, 0.71], price: "-4.7%", hist: [99,98,96,94,90,88,84,82,80] },
  { tkr: "RABBITAI",   chain: "ETH",   pool: "0xcc…d041", prob: 0.81, vol: 3680, bets: 118, ttl: 6 * 3600 + 30 * 60, agents: [0.84, 0.79, 0.78], price: "-9.8%", hist: [97,93,89,84,79,73,68,61,55], new: true },
  { tkr: "OMNIPUP",    chain: "SOL",   pool: "Bx2…fT9",   prob: 0.36, vol: 690,  bets: 22,  ttl: 60 * 3600,         agents: [0.38, 0.30, 0.39], price: "+2.9%", hist: [100,101,102,101,103,103,102,104,103] },
  { tkr: "MEMECON",    chain: "BASE",  pool: "0x40…aa39", prob: 0.52, vol: 1140, bets: 41,  ttl: 36 * 3600,         agents: [0.49, 0.51, 0.54], price: "-0.8%", hist: [100,100,99,100,99,100,99,99,99] },
  { tkr: "ETHKILLER",  chain: "ETH",   pool: "0x21…3c92", prob: 0.44, vol: 870,  bets: 28,  ttl: 48 * 3600,         agents: [0.46, 0.39, 0.46], price: "+0.6%", hist: [100,100,101,100,101,101,100,101,102] },
  { tkr: "DOGAI",      chain: "BASE",  pool: "0x6e…7e8a", prob: 0.58, vol: 1490, bets: 47,  ttl: 24 * 3600,         agents: [0.61, 0.51, 0.61], price: "-1.4%", hist: [100,99,98,98,97,97,96,97,96] },
];

function fmtTtl(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

/* ----------------------------------------------------------------
   Sparkline
   ---------------------------------------------------------------- */

function Spark({ hist, big }) {
  const w = big ? 360 : 80, h = big ? 140 : 32, pad = 4;
  const min = Math.min(...hist), max = Math.max(...hist);
  const range = Math.max(0.5, max - min);
  const step = (w - pad * 2) / (hist.length - 1);
  const pts = hist.map((v, i) => [pad + i * step, pad + (h - pad * 2) * (1 - (v - min) / range)]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const area = line + ` L${(w - pad).toFixed(1)},${(h - pad).toFixed(1)} L${pad},${(h - pad).toFixed(1)} Z`;
  const up = hist[hist.length - 1] >= hist[0];
  return (
    <svg className={"spark " + (up ? "up" : "")} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path className="area" d={area} />
      <path className="line" d={line} />
    </svg>
  );
}

/* ----------------------------------------------------------------
   Market card
   ---------------------------------------------------------------- */

function MarketCard({ m }) {
  const dropped = m.price.startsWith("-");
  return (
    <a href={`#/markets/${m.tkr.toLowerCase()}`} className="mkt-card">
      <div className="mkt-card-head">
        <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
          <div className="tkr">{m.tkr.slice(0, 4)}</div>
          <div>
            <div className="label">
              {m.tkr}
              {m.new && <span className="new-tag">NEW</span>}
            </div>
            <div className="sub">drops &gt;50% · {m.chain} · {m.pool}</div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="prob">{Math.round(m.prob * 100)}%</div>
          <div className={"price-delta " + (dropped ? "dn" : "up")}>{m.price}</div>
        </div>
      </div>
      <Spark hist={m.hist} />
      <div className="bar"><i style={{ width: Math.round(m.prob * 100) + "%" }} /></div>
      <div className="mkt-card-foot">
        <div className="agent-dots" title="agent consensus">
          {m.agents.map((s, i) => (
            <span key={i} className="dot" style={{ background: s > 0.7 ? "var(--ember)" : s > 0.5 ? "var(--amber)" : "var(--ink-4)" }} />
          ))}
          <span style={{ marginLeft: 4 }}>{m.consensus || m.agents.filter((s) => s > 0.5).length + "/3"}</span>
        </div>
        <div className="stats">
          <span><b>${m.vol.toLocaleString()}</b> vol</span>
          <span><b>{m.bets}</b> bets</span>
          <span>ttl <b className="tabular">{fmtTtl(m.ttl)}</b></span>
        </div>
      </div>
    </a>
  );
}

/* ----------------------------------------------------------------
   Markets list page
   ---------------------------------------------------------------- */

function MarketsPage() {
  const [tab, setTab] = useState("hot");
  const [chain, setChain] = useState("all");
  const [q, setQ] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    window.scrollTo(0, 0);
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const list = useMemo(() => {
    const enriched = MARKETS.map((m, i) => ({
      ...m,
      consensus: m.agents.filter((s) => s > 0.5).length + "/3",
      prob: Math.max(0.05, Math.min(0.97, m.prob + Math.sin((tick + i * 8) / 14) * 0.012)),
      ttl: Math.max(60, m.ttl - tick),
    }));
    let f = enriched;
    if (chain !== "all") f = f.filter((m) => m.chain === chain);
    if (q.trim()) f = f.filter((m) => m.tkr.toLowerCase().includes(q.trim().toLowerCase()));
    if (tab === "hot") f = [...f].sort((a, b) => b.prob - a.prob);
    if (tab === "new") f = [...f].sort((a, b) => (b.new ? 1 : 0) - (a.new ? 1 : 0) || b.prob - a.prob);
    if (tab === "closing") f = [...f].sort((a, b) => a.ttl - b.ttl);
    if (tab === "volume") f = [...f].sort((a, b) => b.vol - a.vol);
    return f;
  }, [tab, chain, q, tick]);

  const totalVol = MARKETS.reduce((s, m) => s + m.vol, 0);
  const totalBets = MARKETS.reduce((s, m) => s + m.bets, 0);

  return (
    <div className="page-enter">
      <div className="mkt-topnav">
        <a href="#" className="back">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M7 2L3 5l4 3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          back
        </a>
        <div className="brand">Rugged / Markets</div>
        <div className="meta">arc · live</div>
      </div>

      <section className="mkt-hero">
        <div className="eyebrow" style={{ marginBottom: 14 }}>{MARKETS.length} markets · open</div>
        <h1>All live<br />rug markets.</h1>
        <div className="stats">
          <div className="stat"><div className="v">{MARKETS.length}</div><div className="k">open</div></div>
          <div className="stat"><div className="v">${(totalVol / 1000).toFixed(1)}<span style={{ fontSize: ".5em", color: "var(--ink-3)" }}>k</span></div><div className="k">total volume</div></div>
          <div className="stat"><div className="v">{totalBets}</div><div className="k">bets placed</div></div>
          <div className="stat"><div className="v">87<span style={{ fontSize: ".5em", color: "var(--ink-3)" }}>%</span></div><div className="k">hit-rate · 30d</div></div>
        </div>
      </section>

      <div className="mkt-search">
        <input placeholder="Search ticker, pool, or chain…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="mkt-chips">
          {["hot", "new", "closing", "volume"].map((s) => (
            <button key={s} className={"mkt-chip " + (tab === s ? "on" : "")} onClick={() => setTab(s)}>{s}</button>
          ))}
          <span style={{ flexBasis: "100%", height: 0 }} />
          {["all", "BASE", "ETH", "ARB", "SOL"].map((c) => (
            <button key={c} className={"mkt-chip " + (chain === c ? "on" : "")} onClick={() => setChain(c)}>{c}</button>
          ))}
        </div>
      </div>

      <div className="mkt-list">
        {list.length === 0 ? (
          <div style={{ padding: 60, textAlign: "center", color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 13 }}>
            no markets match — try clearing filters
          </div>
        ) : (
          list.map((m) => <MarketCard key={m.tkr} m={m} />)
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Market detail page (Hot-Take-inspired)
   ---------------------------------------------------------------- */

function ArtChart({ hist }) {
  // Big jagged downward chart silhouette for the background art panel.
  const w = 1000, h = 600, pad = 0;
  const min = Math.min(...hist), max = Math.max(...hist);
  const range = Math.max(0.5, max - min);
  const step = (w - pad * 2) / (hist.length - 1);
  const pts = hist.map((v, i) => [pad + i * step, pad + (h - pad * 2) * (1 - (v - min) / range) * 0.7 + 80]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const area = line + ` L${w},${h} L0,${h} Z`;
  return (
    <svg className="art-chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="artg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--ember)" stopOpacity="0.32" />
          <stop offset="1" stopColor="var(--ember)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#artg)" />
      <path d={line} fill="none" stroke="var(--ember)" strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}

function MarketDetail({ tkr }) {
  const idx = Math.max(0, MARKETS.findIndex((m) => m.tkr.toLowerCase() === tkr));
  const m0 = MARKETS[idx];
  const next = MARKETS[(idx + 1) % MARKETS.length];
  const prev = MARKETS[(idx - 1 + MARKETS.length) % MARKETS.length];

  const [tick, setTick] = useState(0);
  const [side, setSide] = useState(null); // 'rug' | 'safe' | null
  const [amount, setAmount] = useState(5);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    window.scrollTo(0, 0);
    setSide(null);
    setConfirmed(false);
    setAmount(5);
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [tkr]);

  if (!m0) {
    return (
      <div className="page-enter" style={{ padding: 80, textAlign: "center" }}>
        <div style={{ fontFamily: "var(--mono)", color: "var(--ink-3)" }}>market not found</div>
        <a href="#/markets" className="btn-ghost mt-16" style={{ display: "inline-flex" }}>← back to markets</a>
      </div>
    );
  }

  const prob = Math.max(0.05, Math.min(0.97, m0.prob + Math.sin(tick / 14) * 0.012));
  const ttl = Math.max(60, m0.ttl - tick);
  const rugPct = Math.round(prob * 100);
  const safePct = 100 - rugPct;
  const payoutMult = side === "rug" ? (1 / prob) : side === "safe" ? (1 / (1 - prob)) : 0;

  return (
    <div className="detail page-enter" key={tkr}>
      <div className="mkt-topnav">
        <a href="#/markets" className="back">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M7 2L3 5l4 3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          back
        </a>
        <div className="brand">Rugged / {m0.tkr}</div>
        <div className="meta">market · live</div>
      </div>

      <section className="detail-art">
        <div className="glyph" aria-hidden>{m0.tkr.slice(0, 7)}</div>
        <ArtChart hist={m0.hist} />
        <div className="grain" aria-hidden />
        <div className="vignette" aria-hidden />

        <div className="detail-head">
          <div className="pills">
            <span className="pill ember">BLACKLIST</span>
            <span className="pill dim">{m0.tkr.length} chars · {m0.chain}</span>
            <span className="pill dim">binary</span>
          </div>
          <h1>{m0.tkr} drops &gt;50%?</h1>
          <div className="sub">blacklist commit · {m0.pool} · resolves in <span className="tabular">{fmtTtl(ttl)}</span></div>
        </div>
      </section>

      <div className="detail-bet-wrap">
        <div className="detail-position">
          <span className="mono small">{idx + 1} / {MARKETS.length}</span>
          <div className="dots">
            {MARKETS.map((_, i) => (
              <span key={i} className={"d " + (i === idx ? "on" : "")} />
            ))}
          </div>
        </div>

        <div className="detail-bet">
          <div className="hd">
            <div className="lbl">7-day binary · seeded by swarm</div>
            <button className="share" aria-label="share">
              <svg width="14" height="14" viewBox="0 0 14 14"><path d="M9 4l-5 3 5 3M9 4v6" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>

          <div className="prompt">Will {m0.tkr} drop &gt;50%?</div>
          <div className="question">From its blacklist-time price within 7 days. Settled by Pyth feed at expiry.</div>

          <div className="split">
            <div className="side rug">
              <span className="pct rug tabular">{rugPct}<span style={{ fontSize: ".45em" }}>%</span></span>
              <span className="pct-lbl">RUG IT</span>
            </div>
            <div className="vs">|</div>
            <div className="side safe">
              <span className="pct safe tabular">{safePct}<span style={{ fontSize: ".45em" }}>%</span></span>
              <span className="pct-lbl">SAVE IT</span>
            </div>
          </div>

          <div className="meta-row">
            <span><svg width="11" height="11" viewBox="0 0 11 11" style={{verticalAlign:"middle",marginRight:4}}><path d="M2 9V6m3 3V3m3 6V5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg> <b>${m0.vol.toLocaleString()}</b></span>
            <span><svg width="11" height="11" viewBox="0 0 11 11" style={{verticalAlign:"middle",marginRight:4}}><circle cx="5.5" cy="4" r="2" stroke="currentColor" strokeWidth="1.5" fill="none"/><path d="M2 9.5c0-1.5 1.5-2.5 3.5-2.5s3.5 1 3.5 2.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg> <b>{m0.bets}</b></span>
            <span className="agent-dots">
              {m0.agents.map((s, i) => (
                <span key={i} className="dot" style={{ background: s > 0.7 ? "var(--ember)" : s > 0.5 ? "var(--amber)" : "var(--ink-4)" }} />
              ))}
              <span><b>{m0.agents.filter((s) => s > 0.5).length}/3</b> agents</span>
            </span>
          </div>

          {confirmed ? (
            <BetConfirmed side={side} amount={amount} payoutMult={payoutMult} onReset={() => { setConfirmed(false); setSide(null); }} />
          ) : side ? (
            <BetSlip
              side={side}
              amount={amount}
              setAmount={setAmount}
              payoutMult={payoutMult}
              onConfirm={() => setConfirmed(true)}
              onCancel={() => setSide(null)}
            />
          ) : (
            <div className="buttons">
              <button className="btn-rug" onClick={() => setSide("rug")}>
                <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 4l4 4 4-4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
                RUG IT
              </button>
              <button className="btn-safe" onClick={() => setSide("safe")}>
                <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 10l4-4 4 4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
                SAVE IT
              </button>
            </div>
          )}
        </div>

        <a href={`#/markets/${prev.tkr.toLowerCase()}`} className="detail-arrow left" aria-label="previous market">
          <svg width="18" height="18" viewBox="0 0 18 18"><path d="M11 4L6 9l5 5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </a>
        <a href={`#/markets/${next.tkr.toLowerCase()}`} className="detail-arrow right" aria-label="next market">
          <svg width="18" height="18" viewBox="0 0 18 18"><path d="M7 4l5 5-5 5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </a>

        <div className="detail-trace">
          <div className="eyebrow">Swarm reasoning · 3 of 3</div>
          <div className="agent-grid">
            <div className="agent-mini"><div className="role">Contract</div><div className="score">{m0.agents[0].toFixed(2)}</div></div>
            <div className="agent-mini"><div className="role">Social</div><div className="score">{m0.agents[1].toFixed(2)}</div></div>
            <div className="agent-mini"><div className="role">Flow</div><div className="score">{m0.agents[2].toFixed(2)}</div></div>
          </div>
          <a href="#" className="btn-ghost mt-12" style={{ display: "inline-flex" }}>
            View full reasoning trace
            <svg width="11" height="11" viewBox="0 0 11 11" style={{ marginLeft: 4 }}><path d="M3 5h5m0 0L6 3m2 2L6 7" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/></svg>
          </a>
        </div>
      </div>
    </div>
  );
}

function BetSlip({ side, amount, setAmount, payoutMult, onConfirm, onCancel }) {
  const payout = (amount * payoutMult).toFixed(2);
  const profit = (amount * payoutMult - amount).toFixed(2);
  const presets = [5, 10, 25, 100];
  const tone = side === "rug" ? "rug" : "safe";
  return (
    <div className={"betslip " + tone}>
      <div className="betslip-hd">
        <span className="lbl">Bet · {side === "rug" ? "RUG IT" : "SAVE IT"}</span>
        <button className="cancel" onClick={onCancel}>cancel</button>
      </div>
      <div className="amt-row">
        <span className="usd">$</span>
        <input
          type="number"
          inputMode="decimal"
          min="1"
          value={amount}
          onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))}
        />
        <span className="usd-lbl">USDC</span>
      </div>
      <div className="presets">
        {presets.map((p) => (
          <button key={p} className={amount === p ? "on" : ""} onClick={() => setAmount(p)}>${p}</button>
        ))}
      </div>
      <div className="payout">
        <div><span className="k">to win</span><span className="v">${payout}</span></div>
        <div><span className="k">profit</span><span className="v">+${profit}</span></div>
        <div><span className="k">multiplier</span><span className="v">×{payoutMult.toFixed(2)}</span></div>
      </div>
      <button className={"confirm " + tone} onClick={onConfirm}>
        Place ${amount} on {side === "rug" ? "RUG IT" : "SAVE IT"}
      </button>
      <div className="gas-note">paymaster covers gas · no seed phrase</div>
    </div>
  );
}

function BetConfirmed({ side, amount, payoutMult, onReset }) {
  const payout = (amount * payoutMult).toFixed(2);
  const tone = side === "rug" ? "rug" : "safe";
  return (
    <div className={"confirmed " + tone}>
      <div className="check">
        <svg width="20" height="20" viewBox="0 0 20 20"><path d="M5 10l3 3 7-7" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </div>
      <div className="ttl">Bet placed.</div>
      <div className="sub mono">${amount} on {side === "rug" ? "RUG IT" : "SAVE IT"} · to win ${payout}</div>
      <div className="hash mono">tx 0x{Math.random().toString(16).slice(2, 10)}…{Math.random().toString(16).slice(2, 6)}</div>
      <button className="another" onClick={onReset}>place another</button>
    </div>
  );
}

// Export to window so app.jsx can use them.
Object.assign(window, { Spark, MarketCard, MarketsPage, MarketDetail, MARKETS, fmtTtl });
