/* global React */
const { useState, useEffect, useMemo } = React;

/* ----------------------------------------------------------------
   Bond page data
   ---------------------------------------------------------------- */

// 30 resolved markets — ~87% hit rate (26 hits / 4 misses)
const RESOLVED = [
  { tkr: "PEPELON",   chain: "BASE", drop: -72, days: 1.6, hit: true,  ago: "2h" },
  { tkr: "WAGMI42",   chain: "BASE", drop: -89, days: 0.7, hit: true,  ago: "11h" },
  { tkr: "MONA",      chain: "ETH",  drop: -64, days: 3.8, hit: true,  ago: "1d" },
  { tkr: "MOONBOY",   chain: "BASE", drop: -78, days: 1.2, hit: true,  ago: "1d" },
  { tkr: "GROK10",    chain: "BASE", drop: -55, days: 4.1, hit: true,  ago: "2d" },
  { tkr: "SAFEAI",    chain: "ETH",  drop: 12,  days: 7.0, hit: false, ago: "2d" },
  { tkr: "RABBITAI",  chain: "ETH",  drop: -91, days: 0.4, hit: true,  ago: "3d" },
  { tkr: "SHIBA404",  chain: "ETH",  drop: -62, days: 2.9, hit: true,  ago: "3d" },
  { tkr: "GIGACHAD",  chain: "BASE", drop: -84, days: 1.1, hit: true,  ago: "4d" },
  { tkr: "BASEPILL",  chain: "BASE", drop: -58, days: 3.4, hit: true,  ago: "4d" },
  { tkr: "DEGENPUP",  chain: "ARB",  drop: -71, days: 2.3, hit: true,  ago: "5d" },
  { tkr: "TRUTH404",  chain: "SOL",  drop: -67, days: 1.9, hit: true,  ago: "6d" },
  { tkr: "AIDOG",     chain: "BASE", drop: -53, days: 5.7, hit: true,  ago: "7d" },
  { tkr: "DOGAI",     chain: "BASE", drop: -69, days: 2.6, hit: true,  ago: "8d" },
  { tkr: "OMNIPUP",   chain: "SOL",  drop: -76, days: 1.5, hit: true,  ago: "9d" },
  { tkr: "FROGSWAP",  chain: "ARB",  drop: 8,   days: 7.0, hit: false, ago: "10d" },
  { tkr: "MEMECON",   chain: "BASE", drop: -61, days: 3.1, hit: true,  ago: "11d" },
  { tkr: "ETHKILLER", chain: "ETH",  drop: -82, days: 1.4, hit: true,  ago: "12d" },
  { tkr: "VITALIKBOT",chain: "ETH",  drop: -57, days: 4.2, hit: true,  ago: "14d" },
  { tkr: "BABYDOGE2", chain: "BASE", drop: -88, days: 0.9, hit: true,  ago: "15d" },
  { tkr: "LIQUITY",   chain: "ARB",  drop: -64, days: 2.8, hit: true,  ago: "16d" },
  { tkr: "TURBOMOON", chain: "BASE", drop: -73, days: 1.3, hit: true,  ago: "18d" },
  { tkr: "AIINU",     chain: "ETH",  drop: -68, days: 2.1, hit: true,  ago: "19d" },
  { tkr: "WIFLET",    chain: "SOL",  drop: 24,  days: 7.0, hit: false, ago: "21d" },
  { tkr: "GROKDOG",   chain: "BASE", drop: -55, days: 4.6, hit: true,  ago: "22d" },
  { tkr: "ZKPUP",     chain: "BASE", drop: -79, days: 1.8, hit: true,  ago: "24d" },
  { tkr: "ORACLEAI",  chain: "ETH",  drop: -65, days: 2.4, hit: true,  ago: "25d" },
  { tkr: "MOG2",      chain: "BASE", drop: -84, days: 1.0, hit: true,  ago: "27d" },
  { tkr: "DEGENBOT",  chain: "ARB",  drop: -3,  days: 7.0, hit: false, ago: "28d" },
  { tkr: "FEDFRENS",  chain: "ETH",  drop: -71, days: 2.2, hit: true,  ago: "30d" },
];

const HOLDERS = [
  { addr: "0x8a7f…2cd1", amt: 12400, since: "32d" },
  { addr: "0x4291…be0a", amt: 6800,  since: "21d" },
  { addr: "0x5e3c…1abf", amt: 4500,  since: "14d" },
  { addr: "0xbc09…71d2", amt: 3200,  since: "11d" },
  { addr: "0xfa28…8e44", amt: 2100,  since: "7d"  },
  { addr: "0x9b71…442c", amt: 1850,  since: "6d"  },
  { addr: "0x33ae…0f01", amt: 1400,  since: "4d"  },
  { addr: "0xee92…3a78", amt: 980,   since: "2d"  },
];

/* ----------------------------------------------------------------
   Bond page
   ---------------------------------------------------------------- */

function BondPage() {
  const [stake, setStake] = useState(100);
  const [confirmed, setConfirmed] = useState(false);
  const [tick, setTick] = useState(0);
  const [rate, setRate] = useState(87);

  useEffect(() => {
    window.scrollTo(0, 0);
    setConfirmed(false);
    setStake(100);
    const id = setInterval(() => {
      setTick((t) => t + 1);
      setRate((r) => Math.max(78, Math.min(92, r + (Math.random() - 0.5) * 0.6)));
    }, 1800);
    return () => clearInterval(id);
  }, []);

  // gauge math
  const circ = 2 * Math.PI * 90;
  const offset = circ * (1 - rate / 100);
  const tone = rate < 60 ? "bad" : rate < 75 ? "warn" : "";

  const hits = RESOLVED.filter((r) => r.hit).length;
  const misses = RESOLVED.length - hits;
  const liveBonded = 48230 + tick * 13;
  const holdersCount = HOLDERS.length + 31;

  // simple scenario math
  const bullDelta = ((stake * 0.074) / 12).toFixed(2);   // 7.4% APR / month
  const baseDelta = ((stake * 0.051) / 12).toFixed(2);   // 5.1% APR / month
  const bearDelta = (stake * 0.12).toFixed(2);           // 12% slash

  // % of the slider track the thumb has passed — drives the ember fill
  const sliderPct = Math.min(100, Math.max(0, ((stake - 10) / 4990) * 100));

  const scenarios = [
    {
      tag: "bull",
      label: "Hit-rate ≥ 85%",
      delta: `+$${bullDelta}`,
      sub: "30d · USYC yield + redistribution",
      detail: "She holds the line. Idle bet capital earns 5.1% APR via USYC; you also receive a pro-rata share of any forfeited bonds.",
    },
    {
      tag: "base",
      label: "Hit-rate 70–85%",
      delta: `+$${baseDelta}`,
      sub: "30d · idle yield only",
      detail: "No slash. Bond stays whole. USYC yield accrues on the idle pool while markets remain open.",
    },
    {
      tag: "bear",
      label: "Hit-rate < 70%",
      delta: `−$${bearDelta}`,
      sub: "if rate slips to 58% · slash 12%",
      detail: "Below the floor the contract slashes proportionally to the deviation. Slashed USDC flows back into the remaining bondholder pool.",
    },
  ];

  return (
    <div className="page-enter bond-page">
      <div className="mkt-topnav">
        <a href="#" className="back">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M7 2L3 5l4 3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          back
        </a>
      </div>

      <section className="bond-hero">
        <h1 className="bond-hero-title">
          Stake on her <span className="ember">record</span>,<br />not her vibe.
        </h1>
        <p className="bond-hero-lede">
          A human maintainer's hit-rate, priced on-chain. The contract reads her last 30 resolved<br />
          markets every block — and slashes proportionally when she misses below the floor.
        </p>

        <div className="bond-identity">
          <div className="b-avatar">iv</div>
          <div className="b-meta">
            <div className="b-handle">@iterativv</div>
            <div className="b-sub">github.com/iterativv/NostalgiaForInfinity · 4,219 commits · maintainer since 2019</div>
          </div>
          <a href="#" className="b-external" aria-label="open github">
            <svg width="13" height="13" viewBox="0 0 13 13"><path d="M4 4h5v5M9 4L4 9" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </a>
        </div>

        <div className="bond-hero-stats">
          <div className="stat"><div className="v tabular">{Math.round(rate)}<span style={{ fontSize: ".5em", color: "var(--ink-3)" }}>%</span></div><div className="k">hit-rate · 30d</div></div>
          <div className="stat"><div className="v">${(liveBonded / 1000).toFixed(1)}<span style={{ fontSize: ".5em", color: "var(--ink-3)", marginLeft: ".18em" }}>k</span></div><div className="k">total bonded</div></div>
          <div className="stat"><div className="v">{holdersCount}</div><div className="k">bondholders</div></div>
          <div className="stat"><div className="v">70<span style={{ fontSize: ".5em", color: "var(--ink-3)" }}>%</span></div><div className="k">slash floor</div></div>
        </div>
      </section>

      <div className="bond-grid">
        <div className="stake-panel">
          <div className="stake-head">
            <div className="stake-gauge">
              <svg viewBox="0 0 200 200" className="gauge">
                <circle cx="100" cy="100" r="90" fill="none" strokeWidth="14" className="track" />
                <circle cx="100" cy="100" r="90" fill="none" strokeWidth="14" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={offset} className={"fill " + tone} />
              </svg>
              <div className="gauge-center">
                <div className="num tabular">{Math.round(rate)}<span style={{ fontSize: ".32em", color: "var(--ink-3)" }}>%</span></div>
                <div className="lbl">live</div>
              </div>
            </div>
            <div className="stake-head-text">
              <div className="eyebrow"><span>Your bond</span></div>
              <div className="stake-headline">Back her, or sit it out.</div>
              <div className="stake-subhead">Stake USDC. Slash exposure recomputes block-by-block from her 30-market window.</div>
            </div>
          </div>

          {confirmed ? (
            <BondConfirmed amount={stake} rate={rate} onReset={() => { setConfirmed(false); }} />
          ) : (
            <>
              <div className="stake-input">
                <span className="usd">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="1"
                  value={stake}
                  onChange={(e) => setStake(Math.max(1, Number(e.target.value) || 1))}
                />
                <span className="usd-lbl">USDC</span>
              </div>

              <div className="stake-presets">
                {[25, 100, 500, 2500].map((p) => (
                  <button key={p} className={stake === p ? "on" : ""} onClick={() => setStake(p)}>${p.toLocaleString()}</button>
                ))}
              </div>

              <div className="stake-slider-wrap">
                <input
                  type="range"
                  min="10"
                  max="5000"
                  step="5"
                  value={stake}
                  className="stake-slider"
                  style={{ background: `linear-gradient(to right, var(--ember) ${sliderPct}%, var(--bg) ${sliderPct}%)` }}
                  onChange={(e) => setStake(Number(e.target.value))}
                />
                <div className="slider-marks">
                  <span>$10</span><span>$1k</span><span>$5k</span>
                </div>
              </div>

              <div className="scenarios-head">
                <div className="eyebrow"><span>30-day projection · ${stake.toLocaleString()} stake</span></div>
              </div>
              <div className="scenarios">
                {scenarios.map((s) => (
                  <div className={"scenario " + s.tag} key={s.tag}>
                    <div className="s-label">{s.label}</div>
                    <div className="s-delta tabular">{s.delta}</div>
                    <div className="s-sub">{s.sub}</div>
                    <div className="s-detail">{s.detail}</div>
                  </div>
                ))}
              </div>

              <button className="stake-confirm" onClick={() => setConfirmed(true)}>
                Bond ${stake.toLocaleString()} on iterativv
              </button>
              <div className="gas-note">paymaster covers gas · 30-block cooldown to unbond · slash floor 70%</div>
            </>
          )}
        </div>

        <aside className="bond-side">
          <div className="position-card">
            <div className="eyebrow"><span>Position · 0x8a…2cd1</span></div>
            <div className="pos-amount tabular">$420<span className="usd-lbl">USDC</span></div>
            <div className="pos-row"><span className="k">Locked since</span><span className="v">17d ago</span></div>
            <div className="pos-row"><span className="k">Yield · 17d</span><span className="v safe-text">+$2.94</span></div>
            <div className="pos-row"><span className="k">Slash exposure</span><span className="v">−$0.00</span></div>
            <div className="pos-row"><span className="k">Share of pool</span><span className="v">0.87%</span></div>
            <div className="divider" />
            <a href="#" className="pos-link">
              Unbond / start 30-block cooldown
              <svg width="11" height="11" viewBox="0 0 11 11"><path d="M3 5h5m0 0L6 3m2 2L6 7" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>
            </a>
          </div>

          <div className="holders-card">
            <div className="eyebrow"><span>Top bondholders · {holdersCount}</span></div>
            <div className="holders-list">
              {HOLDERS.map((h, i) => (
                <div key={h.addr} className="h-row">
                  <span className="rank">{(i + 1).toString().padStart(2, "0")}</span>
                  <span className="addr">{h.addr}</span>
                  <span className="amt tabular">${h.amt.toLocaleString()}</span>
                  <span className="since">{h.since}</span>
                </div>
              ))}
            </div>
            <a href="#" className="all-link">All {holdersCount} bondholders →</a>
          </div>

          <div className="mechanics-card">
            <div className="eyebrow"><span>How slashing works</span></div>
            <div className="mech-list">
              <div className="mech-row"><span className="n">01</span><span><b>Rolling window.</b> Contract reads last 30 resolved markets every block.</span></div>
              <div className="mech-row"><span className="n">02</span><span><b>Hit = drops &gt;50% in 7d.</b> Settled by Pyth oracle at expiry.</span></div>
              <div className="mech-row"><span className="n">03</span><span><b>Below 70% triggers slash.</b> Slash % = (70 − hit_rate). Linear, no cliff.</span></div>
              <div className="mech-row"><span className="n">04</span><span><b>Slashed USDC redistributes</b> pro-rata to remaining bondholders.</span></div>
              <div className="mech-row"><span className="n">05</span><span><b>Idle pool parks in USYC.</b> 5.1% APR while markets are open.</span></div>
            </div>
          </div>
        </aside>
      </div>

      <section className="resolved-section">
        <div className="resolved-head">
          <div className="eyebrow"><span>Rolling window · last 30 resolved</span></div>
          <h2 className="resolved-title">
            {hits} <span className="ember">hits</span><span className="resolved-mid"> · </span>{misses} <span style={{ color: "var(--ink-3)" }}>misses</span>
          </h2>
          <p className="resolved-lede">Every market she's named in the last 30 days. Ember is a hit — coin dropped &gt;50% within 7 days. Dim is a miss.</p>
        </div>
        <div className="resolved-grid">
          {RESOLVED.map((r, i) => (
            <div key={r.tkr + i} className={"resolved-cell " + (r.hit ? "hit" : "miss")}>
              <div className="r-tkr-block">
                <div className="r-tkr">{r.tkr}</div>
                <div className="r-sub">{r.chain} · {r.days.toFixed(1)}d to resolve · {r.ago}</div>
              </div>
              <div className="r-right">
                <div className="r-drop tabular">{r.drop > 0 ? "+" : ""}{r.drop}%</div>
                <div className="r-verdict">{r.hit ? "hit" : "miss"}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function BondConfirmed({ amount, rate, onReset }) {
  const txHash = useMemo(() => "0x" + Math.random().toString(16).slice(2, 10) + "…" + Math.random().toString(16).slice(2, 6), []);
  const block = useMemo(() => 4_219_011 + Math.floor(Math.random() * 1200), []);
  return (
    <div className="bond-confirmed">
      <div className="check">
        <svg width="22" height="22" viewBox="0 0 20 20"><path d="M5 10l3 3 7-7" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
      <div className="ttl">Bond locked.</div>
      <div className="conf-sub">${amount.toLocaleString()} bonded on iterativv · hit-rate {Math.round(rate)}%</div>
      <div className="conf-hash">tx {txHash} · block {block.toLocaleString()}</div>
      <button className="another" onClick={onReset}>add to position</button>
    </div>
  );
}

// expose
Object.assign(window, { BondPage });
