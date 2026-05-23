/* global React, ReactDOM, TweaksPanel, useTweaks, TweakSection, TweakColor, TweakRadio, TweakToggle */
const { useState, useEffect, useRef, useMemo } = React;

/* ----------------------------------------------------------------
   Data
   ---------------------------------------------------------------- */

// MARKETS + fmtTtl are defined in markets.jsx and exposed on window.

const AGENTS = [
  {
    role: "Agent A · Contract",
    name: "Solidity",
    score: 0.92,
    trace: `mint_auth: NOT renounced
ownership: dev wallet (0x4f..a912)
lp_locked: false (unilateral pull risk)
honeypot_sim: sells_blocked@5%_supply
verdict: high_rug_likelihood
`,
  },
  {
    role: "Agent B · Social",
    name: "Whisper",
    score: 0.78,
    trace: `x_velocity: 142 mentions/h (peaked)
shill_coordination: 14 wallets, same_template
dev_handle: silent_18h, last seen "lfg"
sentiment_delta: -0.41 in 4h
verdict: coordinated_unwind`,
  },
  {
    role: "Agent C · Onchain",
    name: "Flow",
    score: 0.81,
    trace: `lp_change_24h: -38%
dev_wallet_out: 2.4 ETH → tornado
top10_concentration: 71%
cex_inflow_pattern: matches_2023_rugs
verdict: capital_extracting`,
  },
];

const STACK = [
  { lbl: "USDC",     use: "settlement",        emoji: "" },
  { lbl: "Arc",      use: "L1 · sub-sec",      emoji: "" },
  { lbl: "Contracts",use: "factory · bond",    emoji: "" },
  { lbl: "Wallets",  use: "dev-ctrl",          emoji: "" },
  { lbl: "Paymaster",use: "gas-free bets",     emoji: "" },
  { lbl: "USYC",     use: "idle yield",        emoji: "" },
  { lbl: "App Kit",  use: "1-click send",      emoji: "" },
];

const COMMITS = [
  { h: "8e2f4a1", a: "rugcheck", m: "flag: PEPELON 0x4f…a912", t: "06:14:32" },
  { h: "3c9b22d", a: "rugcheck", m: "flag: WAGMI42 0x09…11ab", t: "06:11:09" },
  { h: "5dd91e0", a: "rugcheck", m: "flag: MONA 0xb1…7c3e",   t: "05:58:44" },
  { h: "11a4cc8", a: "rugcheck", m: "clear: SAFEAI (false positive)", t: "05:42:01" },
  { h: "7e3220a", a: "rugcheck", m: "flag: TRUTH404 9aH…kQ2", t: "05:30:55" },
  { h: "0bf6c1c", a: "rugcheck", m: "flag: DEGENPUP 0xfa…d010", t: "05:21:18" },
  { h: "a401fcb", a: "rugcheck", m: "flag: AIDOG 0x77…22fe", t: "04:58:02" },
  { h: "62b8e0e", a: "rugcheck", m: "flag: GROK10 0x12…99ee", t: "04:41:39" },
  { h: "9be4d72", a: "rugcheck", m: "flag: SHIBA404 0x88…0a01", t: "04:22:11" },
];

/* ----------------------------------------------------------------
   Hooks
   ---------------------------------------------------------------- */

function useReveal() {
  useEffect(() => {
    const els = document.querySelectorAll(".reveal");
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("on");
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
}

function useTicker(period = 5000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), period);
    return () => clearInterval(id);
  }, [period]);
  return now;
}

function useScrollProgress() {
  const [p, setP] = useState(0);
  useEffect(() => {
    const fn = () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      setP(max > 0 ? h.scrollTop / max : 0);
    };
    fn();
    window.addEventListener("scroll", fn, { passive: true });
    return () => window.removeEventListener("scroll", fn);
  }, []);
  return p;
}

// fmtTtl lives in markets.jsx and is exposed on window.

/* ----------------------------------------------------------------
   Boot sequence
   ---------------------------------------------------------------- */

function Boot({ done }) {
  const [step, setStep] = useState(0);
  const [prog, setProg] = useState(0);
  const lines = [
    { l: "watcher.connect → rugcheck.xyz", s: "ok" },
    { l: "agent.solidity.warm → claude-4 · contract analyzer", s: "ok" },
    { l: "agent.whisper.warm → claude-4 · social signal", s: "ok" },
    { l: "agent.flow.warm → claude-4 · onchain flow", s: "ok" },
    { l: "trace.registry → arc:0x9c…0a1", s: "ok" },
    { l: "paymaster.attach → gas:$0.00 (usdc)", s: "ok" },
    { l: "market.factory online · block 4,219,008", s: "ok" },
  ];

  useEffect(() => {
    const id = setInterval(() => {
      setStep((s) => {
        if (s >= lines.length) { clearInterval(id); setTimeout(done, 380); return s; }
        return s + 1;
      });
      setProg((p) => Math.min(100, p + (100 / (lines.length + 0.4))));
    }, 240);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="boot" id="boot">
      <div className="box">
        <div className="ttl">Rugged is booting</div>
        {lines.map((ln, i) => (
          <div key={i} className={"line " + (i < step ? "on" : "")}>
            <span className={ln.s === "ok" ? "ok" : "pend"}>{i < step ? "✓" : "·"}</span>
            <span>{ln.l}</span>
          </div>
        ))}
        <div className="progress"><i style={{ width: prog + "%" }} /></div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Rails (desktop only — flanking the mobile column)
   ---------------------------------------------------------------- */

function RailLeft() {
  const [feed, setFeed] = useState(COMMITS);
  useTicker(5200);

  useEffect(() => {
    const id = setInterval(() => {
      setFeed((arr) => {
        const next = [...arr];
        const top = next[0];
        const rotated = [{ ...top, h: Math.random().toString(16).slice(2, 9), t: new Date().toISOString().slice(11, 19) }, ...next.slice(0, -1)];
        return rotated;
      });
    }, 4800);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="rail-inner">
      <h6>Risk feed · rugcheck.xyz</h6>
      <div className="ticker">
        {feed.map((c, i) => (
          <div key={i} className="row">
            <span className="h">{c.h}</span> <span className="s">·</span> {c.m} <span className="s">@ {c.t}</span>
          </div>
        ))}
      </div>
      <h6 className="mt-16">Legend</h6>
      <div className="legend">
        <b>Watcher</b> polls 30s.<br />
        <b>Swarm</b> consensus ≥ 2 of 3.<br />
        <b>Trace</b> SHA-256 → Arc.<br />
        <b>Market</b> auto-opens block n.<br />
        <b>Bond</b> slashes at &lt; 70%.
      </div>
    </div>
  );
}

function RailRight() {
  const p = useScrollProgress();
  return (
    <div className="rail-inner">
      <h6>Scroll</h6>
      <div className="scrollprogress"><i style={{ height: (p * 100) + "%" }} /></div>
      <h6>Section</h6>
      <SectionMarker />
      <h6 className="mt-16">Network</h6>
      <div className="legend">
        chain · <b>arc-testnet</b><br />
        block · <b className="tabular">{4_219_008 + Math.floor(p * 9_400)}</b><br />
        gas · <b>$0.00 (paymaster)</b><br />
        latency · <b>320ms</b>
      </div>
    </div>
  );
}

function SectionMarker() {
  const [name, setName] = useState("intro");
  useEffect(() => {
    const headings = Array.from(document.querySelectorAll("section.s"));
    const io = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (visible[0]) setName(visible[0].target.dataset.name || "intro");
    }, { threshold: [0.25, 0.5, 0.75] });
    headings.forEach((h) => io.observe(h));
    return () => io.disconnect();
  }, []);
  return <div className="legend"><b>{name}</b></div>;
}

/* ----------------------------------------------------------------
   Status bar (mobile-column top)
   ---------------------------------------------------------------- */

function HeaderNav({ route }) {
  const items = [
    { lbl: "Markets",    href: "#/markets", chip: "var(--ember)", match: (r) => r.name === "markets" || r.name === "detail" },
    { lbl: "Swarm",      href: "#swarm",    chip: "var(--amber)" },
    { lbl: "Slash bond", href: "#/bond",    chip: "var(--safe)", match: (r) => r.name === "bond" },
    { lbl: "Docs",       href: "#",         chip: "var(--ink-4)" },
    { lbl: "GitHub",     href: "#",         chip: "var(--ink-4)" },
  ];
  return (
    <header className="headernav">
      <a href="#" className="headernav-logo" aria-label="Rugged home">R</a>
      <nav className="headernav-items">
        {items.map((it) => (
          <a key={it.lbl} href={it.href} className={"headernav-pill" + (it.match && route && it.match(route) ? " active" : "")}>
            <span className="hn-swatch" style={{ background: it.chip }} />
            <span className="lbl">{it.lbl}</span>
          </a>
        ))}
      </nav>
      {window.WalletPill
        ? <window.WalletPill />
        : (
          <a href="#/markets" className="headernav-cta">
            <span className="hn-cta-text">Connect wallet</span>
          </a>
        )}
    </header>
  );
}

/* ----------------------------------------------------------------
   Sections
   ---------------------------------------------------------------- */

function Hero() {
  return (
    <section className="s" data-name="hero" style={{ paddingTop: 144 }}>
      <div className="hero-wrap">
        <div className="hero-main">
          <h3 className="display">
            Trade the <span className="ember">moment</span><br />
            a coin <span className="ember">dies</span>.
          </h3>
          <p className="lede mt-32">
            Rugged turns RugCheck's risk-scoring feed into<br />
            an on-chain prediction market. Three agents verify.<br />
            Markets open <span style={{ color: "var(--ink)", fontWeight: 500 }}>in the same block</span> the rug is named.
          </p>
          <div className="mt-48 btn-row">
            <a href="#/markets" className="btn-xl btn-xl-fx btn-xl-fx--fit">
              <span className="arrow arrow-dup" aria-hidden>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </span>
              <span className="btn-xl-fx__text">
                <span className="btn-xl-fx__label">Browse live markets</span>
              </span>
              <span className="arrow" aria-hidden>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </span>
            </a>
          </div>
        </div>
        <div className="hero-side">
          <div className="stat-row">
            <div className="stat"><div className="v">87<span style={{ fontSize: ".5em", color: "var(--ink-3)" }}>%</span></div><div className="k">RugCheck hit-rate · 30d</div></div>
            <div className="stat"><div className="v">312<span style={{ fontSize: ".5em", color: "var(--ink-3)" }}> ms</span></div><div className="k">commit → market</div></div>
            <div className="stat"><div className="v">$48k</div><div className="k">bonded on RugCheck</div></div>
            <div className="stat"><div className="v">7<span style={{ fontSize: ".5em", color: "var(--ink-3)" }}>/d</span></div><div className="k">circle primitives</div></div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Tape() {
  const items = [
    "ARC · sub-second finality",
    "USDC paymaster · gas-free",
    "swarm consensus ≥ 2 of 3",
    "trace SHA-256 on-chain",
    "USYC idle yield · 5.1%",
    "bond slashes at < 70% hit-rate",
  ];
  return (
    <div className="tape" aria-hidden>
      <div className="track">
        {[...items, ...items, ...items].map((s, i) => <span key={i}>{s}</span>)}
      </div>
    </div>
  );
}

function Nutshell() {
  const items = [
    {
      n: "01",
      ttl: "RugCheck flags it",
      body: "RugCheck's scanner flags a Solana token the moment a rug pattern fires. The signal is public, free, and currently uncapitalized.",
      visual: <CommitVisual />,
    },
    {
      n: "02",
      ttl: "Three agents verify",
      body: "A Solidity analyzer, a social-signal reader, and an onchain-flow tracer each return a rug-likelihood score. Consensus is the agency.",
      visual: <SwarmVisual />,
    },
    {
      n: "03",
      ttl: "A market opens, in-block",
      body: "Arc auto-opens a 7-day “drops >50%” market, seeded by swarm probability. You bet in USDC. Idle capital earns USYC yield until resolution.",
      visual: <MarketVisual />,
    },
  ];
  return (
    <section className="s nut-stair-section" data-name="nutshell" id="how">
      <div className="nut-stair-head">
        <h2 className="nut-stair-title">
          A signal that was ignored<br />
          becomes <span className="ember">a market.</span>
        </h2>
      </div>
      <div className="nut-stair-grid">
        {items.map((it, i) => (
          <div className={"nut-stair-col reveal stair-" + (i + 1)} key={it.n}>
            <div className="nut-stair-num">{it.n} / 03</div>
            <h3 className="nut-stair-cap">{it.ttl}</h3>
            <p className="nut-stair-body">{it.body}</p>
            <div className="nut-stair-visual">
              <div className="grid-bg" />
              {it.visual}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CommitVisual() {
  return (
    <div className="commit-vis">
      <div><span className="hash">8e2f4a1</span> · rugcheck · 06:14:32</div>
      <div>{"  blacklist.json"}</div>
      <div className="rem">- // last edit 4h ago</div>
      <div className="add">+ "0x4fa912…": "PEPELON",</div>
      <div className="add">+ "chain": "base",</div>
      <div className="add">+ "ts": 1763443672</div>
    </div>
  );
}

function SwarmVisual() {
  return (
    <div className="swarm-vis">
      <div className="node hi"><div>SOLIDITY</div><div className="pct">0.92</div></div>
      <div className="node hi"><div>WHISPER</div><div className="pct">0.78</div></div>
      <div className="node hi"><div>FLOW</div><div className="pct">0.81</div></div>
    </div>
  );
}

function MarketVisual() {
  return (
    <div className="market-vis">
      <div className="row"><span>PEPELON · drops &gt;50% / 7d</span><span className="v">83%</span></div>
      <div className="bar"><i style={{ width: "83%" }} /></div>
      <div className="row"><span>volume · $4,280</span><span>ttl · 5h 12m</span></div>
    </div>
  );
}

/* Live markets */

function Markets() {
  const [tab, setTab] = useState("hot");
  const [tick, setTick] = useState(0);
  // Live data only — no fake fallback. If the hook isn't loaded yet, treat
  // it as a loading state.
  const hookResult = (window.useLiveMarkets || (() => ({
    markets: [], loading: true, error: null, source: "loading",
  })))();
  const { markets: dataMarkets, source, loading, error } = hookResult;

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Only show currently-open markets in the home preview.
  const openMarkets = dataMarkets.filter((m) => !m.resolved);

  const list = useMemo(() => {
    return openMarkets.slice(0, 6).map((m, i) => ({
      ...m,
      consensus: m.agents.filter((s) => s > 0.5).length + "/3",
      // gentle probability drift
      prob: Math.max(0.05, Math.min(0.97, m.prob + Math.sin((tick + i * 8) / 14) * 0.012)),
      ttl: Math.max(60, m.ttl - tick),
    }));
  }, [tick, dataMarkets]);

  return (
    <section className="s" data-name="markets" id="markets">
      <div className="section-head">
        <div className="eyebrow">Live markets</div>
        <h2 className="section-title">New rugs pending<br /><span className="ember">judgement</span></h2>
      </div>
      <div className="row" style={{ gap: 6, marginBottom: 24 }}>
        {["hot", "new", "closing"].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="btn-pill"
            style={{
              background: tab === t ? "var(--ink)" : "var(--bg-2)",
              color: tab === t ? "var(--bg)" : "var(--ink-2)",
              borderColor: tab === t ? "var(--ink)" : "var(--line)",
              textTransform: "uppercase",
            }}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="stack gap-8 market-list">
        {loading && list.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 12, border: "1px dashed var(--line)", borderRadius: 8 }}>
            Loading live markets from Arc…
          </div>
        ) : error ? (
          <div style={{ padding: 32, textAlign: "center", color: "var(--ember)", fontFamily: "var(--mono)", fontSize: 12, border: "1px solid color-mix(in oklch, var(--ember), transparent 70%)", borderRadius: 8 }}>
            API unreachable — {error}
          </div>
        ) : list.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 12, border: "1px dashed var(--line)", borderRadius: 8 }}>
            No open markets right now. The swarm is watching the feed — new markets open as the agents fire.
          </div>
        ) : list.map((m, i) => (
          <a
            key={m.market_id != null ? `m-${m.market_id}` : `t-${m.tkr}-${i}`}
            href={`#/markets/${m.tkr.toLowerCase()}`}
            className="market"
            style={{ textAlign: "left", textDecoration: "none", color: "inherit" }}
          >
            <div className="tkr">{m.tkr.slice(0, 4)}</div>
            <div className="stack">
              <div className="label">{m.tkr} <span style={{ color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 10, marginLeft: 4 }}>· drops &gt;50%</span></div>
              <div className="sub">{m.chain} · {m.pool} · {m.consensus} agents · ttl <span className="tabular">{fmtTtl(m.ttl)}</span></div>
              <div className="bar" style={{ marginTop: 8, maxWidth: 220 }}><i style={{ width: Math.round(m.prob * 100) + "%" }} /></div>
            </div>
            <div className="stack" style={{ alignItems: "flex-end", gap: 4 }}>
              <div className="prob up">{Math.round(m.prob * 100)}%</div>
              <div className="sub" style={{ color: m.price.startsWith("-") ? "var(--ember)" : "var(--safe)" }}>{m.price}</div>
            </div>
          </a>
        ))}
      </div>
      <div className="mt-48">
        <a href="#/markets" className="btn-xl btn-xl-fx btn-xl-fx--ink btn-xl-fx--fit">
          <span className="arrow arrow-dup" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </span>
          <span className="btn-xl-fx__text">
            <span className="btn-xl-fx__label">View Markets</span>
          </span>
          <span className="arrow" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </span>
        </a>
      </div>
    </section>
  );
}

/* Swarm */
function Swarm() {
  const { markets: dataMarkets } = (window.useLiveMarkets || (() => ({ markets: [] })))();
  const [liveTrace, setLiveTrace] = useState(null);

  // When live markets exist, pull the most recent one's full trace.
  useEffect(() => {
    const live = (dataMarkets || []).filter((m) => m.live && m.market_id !== undefined);
    if (live.length === 0) return;
    const latest = live[live.length - 1];
    const base = window.RUGGED_API_BASE || "/api";
    fetch(`${base}/markets/${latest.market_id}`)
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((body) => setLiveTrace({ market: body, full: body.full_trace }))
      .catch((err) => console.warn("trace fetch failed:", err));
  }, [dataMarkets]);

  // Choose data source: real trace if available, hardcoded AGENTS otherwise.
  const agentRows = liveTrace && liveTrace.full && liveTrace.full.verdicts
    ? liveTrace.full.verdicts.map((v) => ({
        role: ({
          contract_analyzer: "Agent A · Contract",
          social_signal_analyzer: "Agent B · Social",
          onchain_flow_analyzer: "Agent C · Onchain",
        })[v.agent] || v.agent,
        name: ({
          contract_analyzer: "Solidity",
          social_signal_analyzer: "Whisper",
          onchain_flow_analyzer: "Flow",
        })[v.agent] || "Agent",
        score: v.score,
        confidence: v.confidence,
        trace: (v.key_signals || []).map((s) => "• " + s).join("\n") +
               (v.reasoning ? "\n\n" + v.reasoning : ""),
      }))
    : AGENTS;

  const isLive = !!(liveTrace && liveTrace.full);
  const consensusProb = isLive
    ? liveTrace.market.seed_probability_bps / 10000
    : 0.83;
  const firingCount = isLive
    ? (liveTrace.full.swarm && liveTrace.full.swarm.firing_count) || 0
    : 3;
  const traceHash = isLive ? liveTrace.market.trace && liveTrace.market.trace.hash : "9c2…0a1f";
  const traceUri = isLive ? liveTrace.market.trace && liveTrace.market.trace.uri : null;
  const marketAddr = isLive ? liveTrace.market.address : null;

  return (
    <section className="s" data-name="swarm" id="swarm">
      <div className="section-head">
        <div className="eyebrow">
          The swarm
          {isLive && (
            <span style={{ marginLeft: 10, padding: "2px 8px", background: "var(--ember)", color: "#0a0a0a", borderRadius: 4, fontSize: 9, letterSpacing: ".08em", fontWeight: 600 }}>
              MARKET #{liveTrace.market.market_id} · LIVE
            </span>
          )}
        </div>
        <h2 className="section-title">Three agents.<br />One verdict.<br /><span style={{ color: "var(--ember)" }}>Always logged.</span></h2>
      </div>
      <p className="lede" style={{ marginBottom: 32, whiteSpace: "nowrap" }}>
        Each agent returns a rug-likelihood score and a structured reasoning trace.<br />
        Consensus of ≥ 2 of 3 above 0.5 triggers market creation. Every trace is<br />
        SHA-256 hashed to Arc and pinned for permanent audit.
      </p>
      <div className="stack gap-12 swarm-list">
        {agentRows.map((a, i) => (
          <div className="agent reveal" key={a.role + i}>
            <div className="agent-head">
              <div>
                <div className="role">{a.role}</div>
                <div className="name">{a.name}{isLive && a.confidence !== undefined && (
                  <span style={{ marginLeft: 6, color: "var(--ink-3)", fontSize: 10 }}>
                    · conf {a.confidence.toFixed(2)}
                  </span>
                )}</div>
              </div>
              <div className="score">{a.score.toFixed(2)}</div>
            </div>
            <div className="trace">{a.trace}</div>
          </div>
        ))}
      </div>
      <div className="card mt-16" style={{ borderColor: "var(--ember)" }}>
        <div className="between">
          <div>
            <div className="eyebrow" style={{ color: "var(--ember)" }}>Consensus</div>
            <div style={{ fontFamily: "var(--display)", fontWeight: "var(--display-weight)", fontSize: 30, lineHeight: 1, marginTop: 6, letterSpacing: "var(--display-tracking)" }}>
              {firingCount} of 3 · {isLive ? "market open" : "open market"}
            </div>
          </div>
          <div className="prob up" style={{ fontSize: 40 }}>{consensusProb.toFixed(2)}</div>
        </div>
        <div className="trace mt-16" style={{ maxHeight: "none" }}>
{`trace_hash: ${traceHash ? (isLive ? "0x" + traceHash.slice(0, 16) + "…" + traceHash.slice(-8) : traceHash) : "—"}
${traceUri ? `trace_uri:  ${traceUri.length > 60 ? traceUri.slice(0, 32) + "…" + traceUri.slice(-24) : traceUri}` : "ipfs_cid: bafybeic…q4i"}
${marketAddr ? `market:     ${marketAddr}` : "arc_block: 4,219,011"}
gas_paid:   0.00 USDC (paymaster)`}
        </div>
        {traceUri && (
          <a href={traceUri} target="_blank" rel="noreferrer" className="btn-ghost mt-16" style={{ display: "inline-flex", fontSize: 11 }}>
            View full reasoning trace →
          </a>
        )}
      </div>
    </section>
  );
}

/* Slash bond */
function Bond() {
  const [rate, setRate] = useState(87);
  const target = 70;
  const r = (rate - 0) / 100;
  const circ = 2 * Math.PI * 90;
  const dash = circ;
  const offset = circ * (1 - r);
  const tone = rate < 60 ? "bad" : rate < 75 ? "warn" : "";

  useEffect(() => {
    const id = setInterval(() => {
      setRate((r) => Math.max(64, Math.min(94, r + (Math.random() - 0.5) * 1.4)));
    }, 1800);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="s" data-name="bond" id="bond">
      <div className="section-head">
        <div className="eyebrow">Slash bond</div>
        <h2 className="section-title">Stake on<br />their record,<br />not their vibe.</h2>
      </div>
      <p className="lede" style={{ marginBottom: 32 }}>Users stake USDC alongside RugCheck's risk-scoring record. The contract tracks their hit-rate over the last 30 resolved markets. Below 70%, bonds slash proportionally and redistribute to remaining holders. An analytics firm's reputation, priced on-chain.</p>
      <div className="card bond-card">
        <div className="gauge-wrap">
          <svg viewBox="0 0 200 200" className="gauge">
            <circle cx="100" cy="100" r="90" fill="none" strokeWidth="14" className="track" />
            <circle cx="100" cy="100" r="90" fill="none" strokeWidth="14" strokeLinecap="round" strokeDasharray={dash} strokeDashoffset={offset} className={"fill " + tone} />
          </svg>
          <div className="gauge-center">
            <div>
              <div className="num tabular">{Math.round(rate)}<span style={{ fontSize: ".4em", color: "var(--ink-3)" }}>%</span></div>
              <div className="lbl">hit rate · 30d</div>
            </div>
          </div>
        </div>
        <div className="divider" />
        <div className="stat-row">
          <div className="stat"><div className="v">$48k</div><div className="k">bonded</div></div>
          <div className="stat"><div className="v">{target}%</div><div className="k">slash floor</div></div>
        </div>
        <a href="#/bond" className="btn-xl btn-xl-fx mt-16">
          <span className="arrow arrow-dup" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </span>
          <span className="btn-xl-fx__text">
            <span className="btn-xl-fx__label">Bond on RugCheck</span>
          </span>
          <span className="arrow" aria-hidden>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </span>
        </a>
      </div>
    </section>
  );
}

/* Circle stack */
function Stack() {
  const [usyc, setUsyc] = useState(null);
  useEffect(() => {
    const base = window.RUGGED_API_BASE || "/api";
    fetch(`${base}/usyc/stats`)
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then(setUsyc)
      .catch((err) => console.warn("usyc stats fetch failed:", err));
  }, []);
  const apy = usyc ? usyc.apy_pct.toFixed(2) : "5.12";
  const yieldSource = usyc ? usyc.yield_source : "Hashnote · 30-day trailing";

  return (
    <section className="s" data-name="stack" id="stack">
      <div className="section-head">
        <div className="eyebrow">Built on Circle · Arc</div>
        <h2 className="section-title">Seven<br />Circle<br />primitives.</h2>
      </div>
      <p className="lede mb-16">Arc's sub-second finality and $0.01 USDC gas make this product economically possible. On Ethereum mainnet the gas cost would exceed the alpha. The chain is load-bearing.</p>
      <div className="chip-grid">
        {STACK.map((s) => (
          <div className="chip" key={s.lbl}>
            <span className="lbl">{s.lbl}</span>
            <span className="use">
              {s.lbl === "USYC" && usyc
                ? `${apy}% APY · idle yield`
                : s.use}
            </span>
          </div>
        ))}
      </div>
      <div className="stat-row mt-16">
        <div className="stat"><div className="v">320<span style={{ fontSize: ".5em", color: "var(--ink-3)" }}> ms</span></div><div className="k">block time</div></div>
        <div className="stat"><div className="v">$0.00</div><div className="k">user gas · paymaster</div></div>
        <div className="stat">
          <div className="v">{apy}<span style={{ fontSize: ".5em", color: "var(--ink-3)" }}>%</span></div>
          <div className="k">USYC yield · {yieldSource.split("·")[0].trim()}</div>
        </div>
      </div>
    </section>
  );
}

/* CTA */
function CTA() {
  return (
    <section className="s" data-name="cta">
      <div className="cta-main">
      <h2 className="section-title" style={{ fontSize: "clamp(40px, 12vw, 60px)" }}>
        Open<br />the watcher.<br /><span style={{ color: "var(--ember)" }}>Place a bet.</span>
      </h2>
      <p className="lede mt-16 mb-16">Onboarding via Circle Wallets — email-only, no seed phrases, gas paid in USDC.</p>
      </div>
      <div className="cta-buttons">
      <a href="#/markets" className="btn-xl btn-xl-fx mt-16">
        <span className="arrow arrow-dup" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </span>
        <span className="btn-xl-fx__text">
          <span className="btn-xl-fx__label">Start with $5</span>
        </span>
        <span className="arrow" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </span>
      </a>
      <a href="#" className="btn-xl btn-xl-fx btn-xl-fx--ghost mt-16">
        <span className="arrow arrow-dup" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </span>
        <span className="btn-xl-fx__text">
          <span className="btn-xl-fx__label">Get Telegram alerts</span>
        </span>
        <span className="arrow" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8m0 0L7.5 3.5M11 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </span>
      </a>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <div className="foot-grid">
        <div>
          <h6>Product</h6>
          <a href="#markets">Markets</a>
          <a href="#bond">Slash bond</a>
          <a href="#swarm">The swarm</a>
          <a href="#">Telegram bot</a>
        </div>
        <div>
          <h6>Build</h6>
          <a href="#">Docs</a>
          <a href="#">Trace registry</a>
          <a href="#">GitHub</a>
          <a href="#">API</a>
        </div>
      </div>
      <div className="stamp">
        rugged.markets · arc testnet · agora agents hackathon · canteen × circle × arc · may 25, 2026
      </div>
    </footer>
  );
}

/* ----------------------------------------------------------------
   App
   ---------------------------------------------------------------- */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#ee5a3a",
  "theme": "dark",
  "display": "bricolage",
  "layout": "desktop"
}/*EDITMODE-END*/;

function parseRoute() {
  const h = location.hash || "";
  const detail = h.match(/^#\/markets\/([^/]+)/);
  if (detail) return { name: "detail", tkr: detail[1].toLowerCase() };
  if (h.startsWith("#/markets")) return { name: "markets" };
  if (h.startsWith("#/bond")) return { name: "bond" };
  return { name: "home" };
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [booted, setBooted] = useState(false);
  const [route, setRoute] = useState(parseRoute);
  const routeRef = useRef(route);
  useReveal();

  // hash router
  useEffect(() => {
    const onHash = () => {
      const next = parseRoute();
      const prev = routeRef.current;
      routeRef.current = next;
      setRoute(next);

      // In-page anchor (#swarm, #how, #markets, #bond) → smooth-scroll to that
      // section. A genuine route change → jump to the top.
      const anchorId = next.name === "home" && /^#[\w-]+$/.test(location.hash)
        ? location.hash.slice(1)
        : null;
      if (anchorId) {
        requestAnimationFrame(() => {
          const el = document.getElementById(anchorId);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      } else if (prev.name !== next.name || prev.tkr !== next.tkr) {
        window.scrollTo(0, 0);
      }
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // theme
  useEffect(() => {
    document.documentElement.dataset.theme = t.theme === "paper" ? "paper" : "dark";
  }, [t.theme]);

  // accent
  useEffect(() => {
    document.documentElement.style.setProperty("--ember", t.accent || "#ee5a3a");
  }, [t.accent]);

  // display font swap
  useEffect(() => {
    const root = document.documentElement;
    if (t.display === "mono") {
      root.style.setProperty("--display", "'Geist Mono', monospace");
      root.style.setProperty("--display-weight", "500");
      root.style.setProperty("--display-tracking", "-0.04em");
    } else if (t.display === "geist") {
      root.style.setProperty("--display", "'Geist', sans-serif");
      root.style.setProperty("--display-weight", "700");
      root.style.setProperty("--display-tracking", "-0.05em");
    } else {
      root.style.setProperty("--display", "'Bricolage Grotesque', sans-serif");
      root.style.setProperty("--display-weight", "700");
      root.style.setProperty("--display-tracking", "-0.045em");
    }
  }, [t.display]);

  // layout switch
  useEffect(() => {
    document.documentElement.dataset.layout = t.layout === "desktop" ? "desktop" : "mobile";
  }, [t.layout]);

  return (
    <>
      {!booted && <Boot done={() => setBooted(true)} />}

      <div className="stage">
        <aside className="rail" aria-hidden><RailLeft /></aside>

        <main className="col">
          <HeaderNav route={route} />
          {route.name === "detail" ? (
            <MarketDetail key={"d-" + route.tkr} tkr={route.tkr} />
          ) : route.name === "markets" ? (
            <MarketsPage key="markets" />
          ) : route.name === "bond" ? (
            <BondPage key="bond" />
          ) : (
            <div key="home" className="page-enter">
              <Hero />
              <Tape />
              <Nutshell />
              <Markets />
              <Swarm />
              <Bond />
              <Stack />
              <CTA />
            </div>
          )}
          <Footer />
        </main>

        <aside className="rail" aria-hidden><RailRight /></aside>
      </div>

      <TweaksPanel title="Tweaks">
        <TweakSection label="Theme">
          <TweakRadio label="Mode" value={t.theme} onChange={(v) => setTweak("theme", v)} options={[
            { value: "dark", label: "Dark" },
            { value: "paper", label: "Paper" },
          ]} />
          <TweakColor label="Accent" value={t.accent} onChange={(v) => setTweak("accent", v)} options={[
            "#ee5a3a", "#d6f24a", "#7c9bff", "#f6c453",
          ]} />
        </TweakSection>
        <TweakSection label="Type">
          <TweakRadio label="Display" value={t.display} onChange={(v) => setTweak("display", v)} options={[
            { value: "bricolage", label: "Bricolage" },
            { value: "geist", label: "Geist" },
            { value: "mono", label: "Mono" },
          ]} />
        </TweakSection>
        <TweakSection label="Layout">
          <TweakRadio label="Mode" value={t.layout} onChange={(v) => setTweak("layout", v)} options={[
            { value: "mobile", label: "Mobile" },
            { value: "desktop", label: "Desktop" },
          ]} />
        </TweakSection>
      </TweaksPanel>
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
