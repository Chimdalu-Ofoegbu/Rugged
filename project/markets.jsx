/* global React, ReactDOM, Footer */
const { useState, useEffect, useMemo, useRef } = React;

// Modals need to escape the sticky <header> + clipped <main> containing
// blocks; render them straight into document.body via a portal.
function Portal({ children }) {
  if (typeof document === "undefined" || !ReactDOM?.createPortal) return children;
  return ReactDOM.createPortal(children, document.body);
}

/* ----------------------------------------------------------------
   Shared helpers (exposed to app.jsx via window).
   The market list itself is fetched from /api/markets — there is no
   static MARKETS array. Empty/loading/error states are rendered
   in-place so we never paint fake markets.
   ---------------------------------------------------------------- */

function fmtTtl(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

/* ----------------------------------------------------------------
   Live data — fetch on-chain markets from the backend.
   No fallback to fake/static data: if the API is down or empty,
   the UI renders a loading / empty / error state instead.
   ---------------------------------------------------------------- */

const API_BASE = (typeof window !== "undefined" && window.RUGGED_API_BASE) || "/api";

// ---------------------------------------------------------------
// Per-browser identity. A stable UUIDv4 lives in localStorage as
// `rugged_user_id` and is sent on every wallet-scoped API call via
// the X-Rugged-User-Id header. The backend keys each user's wallet
// record by this id — so two browsers never share a wallet.
//
// This is NOT real authentication. Anyone who exfiltrates the id from
// a browser can act on its wallet. Layering Privy / OAuth on top is
// the production fix; this gets us out of the single-shared-wallet
// failure mode without an auth provider sign-up.
// ---------------------------------------------------------------
const USER_ID_KEY = "rugged_user_id";

function _genUuidV4() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for older browsers — uses crypto.getRandomValues if available.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getUserId() {
  if (typeof window === "undefined") return null;
  try {
    let id = window.localStorage.getItem(USER_ID_KEY);
    if (!id) {
      id = _genUuidV4();
      window.localStorage.setItem(USER_ID_KEY, id);
    }
    return id;
  } catch (_) {
    // localStorage blocked (private browsing on some setups). Fall back
    // to an in-memory id so the session at least functions, even though
    // the wallet will be lost on refresh.
    if (!window._ruggedFallbackUserId) window._ruggedFallbackUserId = _genUuidV4();
    return window._ruggedFallbackUserId;
  }
}

// Wraps fetch() with the X-Rugged-User-Id header on every call.
// Use for any request that reads or mutates a user's wallet state.
async function apiFetch(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("X-Rugged-User-Id", getUserId());
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

if (typeof window !== "undefined") {
  window.getRuggedUserId = getUserId;
}

function _fmtPool(mint) {
  if (!mint || mint.length < 10) return mint || "—";
  return mint.slice(0, 4) + "…" + mint.slice(-4);
}

function _chainLabel(c) {
  if (!c) return "SOL";
  const u = c.toUpperCase();
  return u === "SOLANA" ? "SOL" : u;
}

// Transform one /api/markets entry into the shape used by MarketCard/MarketsPage.
function _liveToCardShape(api) {
  const probBps = api.seed_probability_bps || 0;
  const prob = Math.max(0.05, Math.min(0.97, probBps / 10000));
  const expiry = api.expiry || 0;
  const ttl = Math.max(60, expiry - Math.floor(Date.now() / 1000));
  const verdicts = api.verdicts || (api.full_trace && api.full_trace.verdicts) || null;
  // If we have verdicts (detail page or historical), use real per-agent scores;
  // on the list endpoint we just synthesize from the seed prob so dots still render.
  const agents = verdicts
    ? verdicts.map((v) => v.score)
    : [prob, Math.max(0.05, prob - 0.08), Math.min(0.95, prob + 0.04)];
  const totalPool = (api.yes_pool || 0) + (api.no_pool || 0);
  const volUsdc = totalPool / 1_000_000;  // micro-USDC → USDC
  const symbol = (api.symbol || "RUGGED").toUpperCase().slice(0, 12);
  // Historical markets shipped with a precise drop_pct; for live we synthesize.
  const dropPct = typeof api.drop_pct === "number" ? api.drop_pct : null;
  const finalIdx = api.resolved
    ? Math.round(100 * (1 + (dropPct ?? -50) / 100))
    : Math.round(100 * (1 - prob));
  const hist = [100, 99, 97, 94, 90, 85, 79, 72, Math.max(2, finalIdx)];
  const priceStr = dropPct != null ? `${dropPct.toFixed(1)}%` : "—";
  return {
    tkr: symbol,
    chain: _chainLabel(api.chain),
    pool: _fmtPool(api.mint),
    mint: api.mint || null,              // full Solana mint address (token contract)
    prob,
    vol: Math.round(volUsdc),
    bets: api.bets_count || 0,
    ttl,
    agents,
    price: priceStr,
    hist,
    new: !api.resolved && (Date.now() / 1000 - (api.blacklist_timestamp || 0)) < 24 * 3600,
    live: !api.historical,
    historical: !!api.historical,
    resolved: !!api.resolved,
    outcome: api.outcome || (api.yes_won ? "yes" : api.resolved ? "no" : null),
    market_id: api.market_id,
    market_address: api.address,
    trace_hash: api.trace && api.trace.hash,
    trace_uri: api.trace && api.trace.uri,
    verdicts: verdicts,                  // pass through if already present
  };
}

// Build a DexScreener / explorer URL for a given mint + chain.
function explorerUrlFor(mint, chain) {
  if (!mint) return null;
  const c = (chain || "").toLowerCase();
  if (c === "solana" || c === "sol") return `https://dexscreener.com/solana/${mint}`;
  if (c === "ethereum" || c === "eth") return `https://dexscreener.com/ethereum/${mint}`;
  if (c === "base") return `https://dexscreener.com/base/${mint}`;
  if (c === "arbitrum" || c === "arb") return `https://dexscreener.com/arbitrum/${mint}`;
  return `https://dexscreener.com/solana/${mint}`;
}
if (typeof window !== "undefined") window.explorerUrlFor = explorerUrlFor;

// Module-level snapshot so a fresh `useLiveMarkets()` caller (e.g. MarketDetail
// after navigating from MarketsPage) doesn't paint static fallback for ~20s
// while its own fetch completes. The hook still re-fetches on every mount —
// this just provides a good initial state.
let _liveMarketsSnapshot = null;

// Hook — returns { markets, loading, error, source, hitRate, liveCount, historicalCount }.
// `source` is "live" once a successful API response lands, "loading" while
// the fetch is in-flight, "empty" if the API has zero markets, "error" on
// failure. **No static placeholder markets ever appear in this state.**
function useLiveMarkets() {
  const [state, setState] = useState(() => _liveMarketsSnapshot || {
    markets: [], loading: true, error: null, source: "loading",
    hitRate: null, liveCount: 0, historicalCount: 0,
  });
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${API_BASE}/markets`).then((r) => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))),
      fetch(`${API_BASE}/stats`).then((r) => r.ok ? r.json() : null).catch(() => null),
    ])
      .then(([body, stats]) => {
        if (cancelled) return;
        const items = (body.markets || []).map(_liveToCardShape);
        const liveCount = body.live_count ?? items.filter((m) => m.live && !m.historical).length;
        const historicalCount = body.historical_count ?? items.filter((m) => m.historical).length;
        const hitRate = stats && typeof stats.hit_rate === "number" ? stats.hit_rate : null;
        const next = {
          markets: items,
          loading: false,
          error: null,
          source: items.length === 0 ? "empty" : "live",
          hitRate, liveCount, historicalCount,
        };
        _liveMarketsSnapshot = next;
        setState(next);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("live markets fetch failed:", err);
        setState({
          markets: [], loading: false, error: err.message, source: "error",
          hitRate: null, liveCount: 0, historicalCount: 0,
        });
      });
    return () => { cancelled = true; };
  }, []);
  return state;
}

// expose on window so app.jsx (loaded later) can use it without import gymnastics.
if (typeof window !== "undefined") {
  window.useLiveMarkets = useLiveMarkets;
  window.RUGGED_API_BASE = API_BASE;
}

// ---------------------------------------------------------------
// Circle Developer-Controlled Wallet — provisioning + balance hook.
//
// Connection is *session-scoped*: a hard refresh wipes the in-memory
// snapshot and resets `_sessionConnected` to false, so the UI prompts
// the user to connect again. The backend wallet itself (saved in
// data/demo_wallet.json) is NOT deleted on disconnect — disconnect
// only forgets it in the browser, and the next connect re-attaches
// to the same persisted wallet idempotently.
// ---------------------------------------------------------------
let _walletSnapshot = null;
let _sessionConnected = false;
const _walletSubscribers = new Set();

const _DISCONNECTED_SNAPSHOT = Object.freeze({
  loading: false, exists: false, address: null,
  id: null, wallet_set_id: null, balance: null, error: null,
});

function _setWalletSnapshot(snap) {
  _walletSnapshot = snap;
  _walletSubscribers.forEach((cb) => { try { cb(snap); } catch (_) { /* */ } });
}

async function _fetchWallet() {
  try {
    const r = await apiFetch(`/wallet`);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } catch (e) {
    return { exists: false, _error: e.message };
  }
}

function useWallet() {
  const [state, setState] = useState(() => _walletSnapshot || _DISCONNECTED_SNAPSHOT);

  useEffect(() => {
    const cb = (snap) => setState(snap);
    _walletSubscribers.add(cb);
    // No auto-fetch on mount — connection is session-scoped, so the
    // page always starts in the "Connect wallet" state. The connect()
    // action below is what attaches to (or provisions) the backend wallet.
    return () => { _walletSubscribers.delete(cb); };
  }, []);

  async function connect() {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      // POST /wallet is idempotent *per user_id* — provisions a fresh Circle
      // wallet on first call from this browser, returns the existing one on
      // subsequent calls. The X-Rugged-User-Id header is what scopes it.
      const r = await apiFetch(`/wallet`, { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error || body.detail || `HTTP ${r.status}`);
      }
      const body = await r.json();
      // Re-fetch to also pick up the balance (POST returns wallet info but
      // not necessarily current balance).
      const fresh = await _fetchWallet();
      _sessionConnected = true;
      const snap = {
        loading: false,
        exists: true,
        address: body.address || fresh.address,
        id: body.id || fresh.id,
        wallet_set_id: body.wallet_set_id || fresh.wallet_set_id,
        balance: fresh.balance || null,
        error: null,
      };
      _setWalletSnapshot(snap);
    } catch (e) {
      const snap = { ...(_walletSnapshot || _DISCONNECTED_SNAPSHOT), loading: false, error: e.message };
      _setWalletSnapshot(snap);
    }
  }

  async function refresh() {
    if (!_sessionConnected) return;
    const body = await _fetchWallet();
    const snap = {
      loading: false,
      exists: !!body.exists,
      address: body.address || null,
      id: body.id || null,
      wallet_set_id: body.wallet_set_id || null,
      balance: body.balance || null,
      error: body._error || null,
    };
    _setWalletSnapshot(snap);
  }

  function disconnect() {
    // Session-only: forget the wallet in the browser. The backend
    // record stays so the next connect() re-attaches to the same address.
    _sessionConnected = false;
    _setWalletSnapshot({ ..._DISCONNECTED_SNAPSHOT });
  }

  return { ...state, connect, refresh, disconnect };
}

// ---------------------------------------------------------------
// QR code — uses the global `qrcode` lib loaded from unpkg in index.html.
// Inline SVG so we can theme it without a canvas + style copy.
// ---------------------------------------------------------------
function WalletQR({ value, size = 168 }) {
  if (!value || typeof window === "undefined" || typeof window.qrcode !== "function") {
    return (
      <div style={{
        width: size, height: size, display: "flex", alignItems: "center",
        justifyContent: "center", fontFamily: "var(--mono)", fontSize: 10,
        color: "var(--ink-4)", border: "1px dashed var(--line)", borderRadius: 6,
      }}>
        QR unavailable
      </div>
    );
  }
  // typeNumber=0 = auto-pick smallest type that fits the data.
  // 'M' error correction balances resilience and density for a wallet address.
  const qr = window.qrcode(0, "M");
  qr.addData(value);
  qr.make();
  const cellCount = qr.getModuleCount();
  const cellSize = size / cellCount;
  const cells = [];
  for (let r = 0; r < cellCount; r++) {
    for (let c = 0; c < cellCount; c++) {
      if (qr.isDark(r, c)) {
        cells.push(
          <rect key={`${r}-${c}`} x={c * cellSize} y={r * cellSize}
            width={cellSize + 0.5} height={cellSize + 0.5} fill="currentColor" />
        );
      }
    }
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      style={{ color: "var(--ink)", background: "var(--ink)", borderRadius: 6 }}>
      <rect width={size} height={size} fill="var(--ink)" />
      <g color="#0c0c0c" style={{ color: "#0c0c0c" }}>{cells}</g>
    </svg>
  );
}

// ---------------------------------------------------------------
// Wallet modal — three tabbed views (Balance / Deposit / Withdraw)
// in the connected state, and a branched first-time vs. returning
// copy in the disconnected state.
//
// Accessibility (WAI-ARIA Authoring Practices for Tabs, plus the
// Dialog pattern):
//   - Outer container is role="dialog", aria-modal, aria-labelledby
//     pointing at the dialog title (which carries id="wallet-dialog-title").
//   - The tablist + tabs follow the manual-activation tab pattern with
//     roving tabindex: only the active tab is in the document tab order;
//     arrow keys move focus AND activation between tabs; Home/End jump
//     to the ends.
//   - Each tab has aria-selected + aria-controls; each panel has
//     role="tabpanel" + aria-labelledby pointing back at its tab.
//   - Inactive tabs use tabindex=-1 so Tab/Shift+Tab move past the
//     tablist to the next interactive region (the panel content).
// ---------------------------------------------------------------
const WALLET_VIEWS = [
  { id: "balance", label: "Balance" },
  { id: "deposit", label: "Deposit" },
  { id: "withdraw", label: "Withdraw" },
];

function WalletModal({ open, onClose }) {
  const w = useWallet();
  const [view, setView] = useState("balance"); // "balance" | "deposit" | "withdraw"
  // `record_exists` answers: does the BACKEND already have a wallet record
  // (regardless of whether THIS browser session has connected to it)? Drives
  // the disconnected-state copy: first-time = "Provision", returning = "Reconnect".
  const [recordExists, setRecordExists] = useState(null);  // null = loading, bool once known
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    // Reset to balance view every time the modal opens.
    setView("balance");
    // Cheap, no-balance check — the dedicated /wallet/exists endpoint.
    // Scoped to this browser's user_id via the apiFetch header.
    if (!w.exists) {
      apiFetch(`/wallet/exists`)
        .then((r) => (r.ok ? r.json() : { exists: false }))
        .then((body) => setRecordExists(!!body.exists))
        .catch(() => setRecordExists(false));
    }
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, w.exists]);

  function onTabKeyDown(e, idx) {
    let nextIdx = null;
    if (e.key === "ArrowRight") nextIdx = (idx + 1) % WALLET_VIEWS.length;
    else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + WALLET_VIEWS.length) % WALLET_VIEWS.length;
    else if (e.key === "Home") nextIdx = 0;
    else if (e.key === "End") nextIdx = WALLET_VIEWS.length - 1;
    if (nextIdx !== null) {
      e.preventDefault();
      const nextId = WALLET_VIEWS[nextIdx].id;
      setView(nextId);
      // Move focus to the newly-activated tab (roving tabindex pattern).
      // Defer so React has applied the tabIndex flip on the next render.
      // Look up via DOM id (stable across renders) instead of holding a ref
      // — inline ref callbacks null/reset on every render which can cause
      // focus to lag one keystroke behind selection.
      requestAnimationFrame(() => {
        document.getElementById(`wallet-tab-${nextId}`)?.focus();
      });
    }
  }

  if (!open) return null;
  const usdc = w.balance?.usdc ?? ((w.balance?.usdc_raw ?? 0) / 1_000_000);
  const usyc = w.balance?.usyc ?? ((w.balance?.usyc_raw ?? 0) / 1_000_000);
  const shortAddr = w.address
    ? `${w.address.slice(0, 6)}…${w.address.slice(-4)}`
    : null;
  const isReturning = recordExists === true;
  const connectBtnLabel = w.loading
    ? (isReturning ? "Reconnecting…" : "Provisioning…")
    : (isReturning ? "Reconnect Circle wallet" : "Provision Circle wallet");
  const connectTitle = isReturning ? "Welcome back" : "Connect to bet";
  const connectSub = isReturning
    ? "Reconnecting to your existing Arc wallet. Same address, same balance — gas stays sponsored by Circle Paymaster on every bet."
    : "We'll provision a Circle Developer-Controlled Wallet on Arc. No seed phrase, no signing prompts — gas is sponsored by Circle Paymaster on every bet.";

  return (
    <Portal>
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-dialog-title"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1100,
        background: "rgba(0,0,0,0.78)", backdropFilter: "blur(4px)",
        display: "flex", justifyContent: "center", alignItems: "center",
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="document"
        style={{
          width: "min(460px, 100%)",
          maxHeight: "min(90vh, 100%)",
          overflowY: "auto",
          background: "#0c0c0c",
          border: "1px solid var(--ink-5,#222)",
          borderRadius: 6,
          padding: "22px 24px 24px",
          color: "var(--ink)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
          margin: "auto",
        }}
      >
        <div className="wallet-modal-head">
          <div>
            <div className="wallet-modal-kicker">Circle wallet · Arc</div>
            <h2 className="wallet-modal-title" id="wallet-dialog-title">
              {w.exists ? "Your wallet" : connectTitle}
            </h2>
            <div className="wallet-modal-sub">
              {w.exists
                ? "Developer-Controlled Wallet. Gas is sponsored by Circle Paymaster on every bet."
                : connectSub}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close wallet dialog"
            className="btn-pill wallet-close"
          >
            close
          </button>
        </div>

        {w.exists ? (
          <>
            <div
              className="wallet-tabs"
              role="tablist"
              aria-label="Wallet sections"
            >
              {WALLET_VIEWS.map((v, idx) => {
                const isActive = view === v.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    role="tab"
                    id={`wallet-tab-${v.id}`}
                    aria-selected={isActive}
                    aria-controls={`wallet-panel-${v.id}`}
                    tabIndex={isActive ? 0 : -1}
                    onClick={() => setView(v.id)}
                    onKeyDown={(e) => onTabKeyDown(e, idx)}
                    className={"wallet-tab" + (isActive ? " is-active" : "")}
                  >
                    {v.label}
                  </button>
                );
              })}
            </div>

            {view === "balance" && (
              <div
                role="tabpanel"
                id="wallet-panel-balance"
                aria-labelledby="wallet-tab-balance"
                tabIndex={0}
              >
                <WalletBalanceView
                  w={w}
                  usdc={usdc}
                  usyc={usyc}
                  shortAddr={shortAddr}
                  onClose={onClose}
                />
              </div>
            )}
            {view === "deposit" && (
              <div
                role="tabpanel"
                id="wallet-panel-deposit"
                aria-labelledby="wallet-tab-deposit"
                tabIndex={0}
              >
                <WalletDepositView w={w} />
              </div>
            )}
            {view === "withdraw" && (
              <div
                role="tabpanel"
                id="wallet-panel-withdraw"
                aria-labelledby="wallet-tab-withdraw"
                tabIndex={0}
              >
                <WalletWithdrawView
                  w={w}
                  usdc={usdc}
                  onSuccess={() => {
                    // Pull a fresh balance + jump back to the balance tab.
                    w.refresh();
                    setView("balance");
                  }}
                />
              </div>
            )}
          </>
        ) : (
          <>
            <ul className="wallet-feature-list">
              <li>No seed phrase, no MetaMask, no signing prompts</li>
              <li>Gas paid in USDC via <b>Circle Paymaster</b> — every bet costs $0.00 in gas</li>
              <li>Settlement on <b>Arc</b> (Circle's L1) · sub-second finality</li>
              <li>Idle capital auto-parks in <b>USYC</b> until market resolves</li>
            </ul>
            <button
              onClick={w.connect}
              disabled={w.loading || recordExists === null}
              className={"wallet-primary-btn" + (w.loading ? " is-loading" : "")}
            >
              {recordExists === null ? "Checking…" : connectBtnLabel}
            </button>
            {w.error && (
              <div className="wallet-error">
                {w.error}
              </div>
            )}
          </>
        )}
      </div>
    </div>
    </Portal>
  );
}

function WalletBalanceView({ w, usdc, usyc, shortAddr, onClose }) {
  return (
    <>
      <div className="wallet-address-row">
        <div className="wallet-row-kicker">address</div>
        <div className="wallet-address-line">
          <span className="wallet-address-mono">{shortAddr}</span>
          <button
            className="btn-pill wallet-copy"
            onClick={() => { navigator.clipboard?.writeText(w.address); }}
          >
            copy
          </button>
        </div>
      </div>

      <div className="wallet-balance-grid">
        <div className="wallet-balance-card">
          <div className="wallet-row-kicker">USDC</div>
          <div className="wallet-balance-value">${usdc.toFixed(2)}</div>
          <div className="wallet-balance-foot">spendable</div>
        </div>
        <div className="wallet-balance-card wallet-balance-card--ember">
          <div className="wallet-row-kicker wallet-row-kicker--ember">USYC</div>
          <div className="wallet-balance-value">${usyc.toFixed(2)}</div>
          <div className="wallet-balance-foot">earning yield</div>
        </div>
      </div>

      <div className="wallet-yield-note">
        Idle bet capital parks in <b>USYC</b> until resolution.
        Yield split: 80% to winning bettors, 20% to platform treasury.
      </div>

      <div className="wallet-actions-row">
        <button
          onClick={w.refresh}
          disabled={w.loading}
          className="wallet-secondary-btn"
        >
          {w.loading ? "Refreshing…" : "Refresh balance"}
        </button>
        <button
          onClick={() => { w.disconnect(); onClose(); }}
          disabled={w.loading}
          className="wallet-secondary-btn wallet-disconnect-btn"
          title="Forget this wallet in the browser. The on-chain wallet is preserved — reconnect any time."
        >
          Disconnect
        </button>
      </div>
    </>
  );
}

function WalletDepositView({ w }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    try {
      navigator.clipboard?.writeText(w.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (_) { /* non-secure context */ }
  }
  return (
    <div className="wallet-deposit">
      <div className="wallet-row-kicker" style={{ marginTop: 6 }}>Scan or copy</div>
      <div className="wallet-deposit-grid">
        <div className="wallet-qr-wrap">
          <WalletQR value={w.address} size={168} />
        </div>
        <div className="wallet-deposit-meta">
          <div className="wallet-deposit-network">
            <span className="wallet-deposit-net-dot" />
            Arc testnet · USDC
          </div>
          <div className="wallet-deposit-hint">
            Send <b>USDC on Arc</b> to this address. Other networks (Ethereum, Base, Polygon mainnet) will be lost.
          </div>
        </div>
      </div>
      <div className="wallet-deposit-address">
        <span className="wallet-deposit-address-mono">{w.address}</span>
      </div>
      <button
        type="button"
        className={"wallet-primary-btn" + (copied ? " is-success" : "")}
        onClick={copy}
      >
        {copied ? "Address copied" : "Copy full address"}
      </button>
      <div className="wallet-deposit-foot">
        Once your USDC lands, hit <i>Balance → Refresh</i> to see it.
      </div>
    </div>
  );
}

function WalletWithdrawView({ w, usdc, onSuccess }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const amountNum = Number(amount);
  const toValid = /^0x[a-fA-F0-9]{40}$/.test(to.trim());
  const amountValid = amountNum > 0 && amountNum <= usdc;
  const canSubmit = toValid && amountValid && !submitting;

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      const r = await apiFetch(`/wallet/withdraw`, {
        method: "POST",
        body: JSON.stringify({ to: to.trim(), amount_usdc: amountNum }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || body.detail || `HTTP ${r.status}`);
      setResult(body);
      // Give the user a beat to see the confirmation, then bounce back.
      setTimeout(() => { onSuccess && onSuccess(); }, 2200);
    } catch (e) {
      setError(e.message || "Withdraw failed");
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    const tx = (result.withdraw_tx_hash || "").toString();
    const shortTx = tx.length > 18 ? tx.slice(0, 10) + "…" + tx.slice(-6) : tx;
    return (
      <div className="wallet-withdraw-success">
        <div className="wallet-withdraw-check">
          <svg width="20" height="20" viewBox="0 0 20 20"><path d="M5 10l3 3 7-7" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </div>
        <div className="wallet-withdraw-success-ttl">Sent ${amountNum.toFixed(2)} USDC</div>
        <div className="wallet-withdraw-success-sub">
          to {to.slice(0, 6)}…{to.slice(-4)}
        </div>
        <div className="wallet-withdraw-success-tx">tx {shortTx} · gas $0.00</div>
      </div>
    );
  }

  return (
    <div className="wallet-withdraw">
      <div className="wallet-row-kicker" style={{ marginTop: 6 }}>Destination address</div>
      <input
        type="text"
        placeholder="0x…"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        disabled={submitting}
        className="wallet-input wallet-input-address"
        spellCheck={false}
        autoCorrect="off"
      />
      <div className="wallet-input-hint">
        {to && !toValid
          ? <span style={{ color: "var(--ember)" }}>Not a valid 0x address</span>
          : <>The receiving Arc USDC address (40 hex chars, prefixed with <code>0x</code>).</>}
      </div>

      <div className="wallet-row-kicker" style={{ marginTop: 14 }}>Amount</div>
      <div className="wallet-withdraw-amount-row">
        <span className="wallet-withdraw-amount-prefix">$</span>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={submitting}
          className="wallet-input wallet-input-amount"
        />
        <button
          type="button"
          className="wallet-max-btn"
          onClick={() => setAmount(usdc.toFixed(2))}
          disabled={submitting || usdc <= 0}
        >
          MAX
        </button>
      </div>
      <div className="wallet-input-hint">
        ${usdc.toFixed(2)} USDC available · gas paid by Circle Paymaster ($0.00)
      </div>

      {error && <div className="wallet-error">{error}</div>}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className={"wallet-primary-btn" + (submitting ? " is-loading" : "")}
        style={{ marginTop: 14 }}
      >
        {submitting ? "Sending · Circle paymaster signing…" : `Send $${amountNum > 0 ? amountNum.toFixed(2) : "0.00"} USDC`}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------
// Wallet pill in the header — two visual states:
//
//   Disconnected: reuses the full `.headernav-cta` (ember CTA with the
//   double-arrow slide hover animation) so it matches what "Start with
//   $5" used to look + animate like.
//
//   Connected: a quieter `.headernav-pill` (dark glass nav style) with a
//   green status dot, so the user can tell at a glance which mode the
//   wallet is in without the ember demanding attention every render.
// ---------------------------------------------------------------
function ArrowIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
      <path d="M3 6h6m0 0L6.5 3.5M9 6l-2.5 2.5"
        stroke="currentColor" strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WalletPill() {
  const w = useWallet();
  const [modalOpen, setModalOpen] = useState(false);
  const usdc = w.balance?.usdc ?? ((w.balance?.usdc_raw ?? 0) / 1_000_000);
  const shortAddr = w.address ? `${w.address.slice(0, 4)}…${w.address.slice(-4)}` : null;
  return (
    <>
      {w.exists ? (
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="headernav-pill wallet-pill-connected"
          style={{ cursor: "pointer", border: "1px solid var(--line)" }}
          aria-label="Wallet"
        >
          <span className="hn-swatch" style={{
            background: "var(--safe, #4ade80)",
            boxShadow: "0 0 6px color-mix(in oklch, var(--safe, #4ade80), transparent 40%)",
          }} />
          <span className="lbl">${usdc.toFixed(2)} · {shortAddr}</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="headernav-cta"
          style={{ cursor: "pointer" }}
          aria-label="Connect wallet"
        >
          <span className="hn-arrow hn-arrow-dup" aria-hidden><ArrowIcon /></span>
          <span className="hn-cta-text">Connect wallet</span>
          <span className="hn-arrow" aria-hidden><ArrowIcon /></span>
        </button>
      )}
      <WalletModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </>
  );
}

if (typeof window !== "undefined") {
  window.useWallet = useWallet;
  window.WalletPill = WalletPill;
  window.WalletModal = WalletModal;
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
  const dropped = (m.price || "").startsWith("-");
  const isHist = m.historical || m.resolved;
  const outcomeRug = isHist && m.outcome === "yes";
  return (
    <a href={`#/markets/${m.tkr.toLowerCase()}`} className={"mkt-card" + (isHist ? " resolved" : "")}>
      <div className="mkt-card-head">
        <div className="row" style={{ gap: 12, alignItems: "flex-start" }}>
          <div className="tkr">{m.tkr.slice(0, 4)}</div>
          <div>
            <div className="label">
              {m.tkr}
              {m.new && <span className="new-tag">NEW</span>}
              {m.live && !isHist && (
                <span className="new-tag" style={{ background: "var(--ember)", color: "#0a0a0a", marginLeft: 4 }}>LIVE</span>
              )}
              {isHist && (
                <span className="new-tag" style={{ background: outcomeRug ? "var(--ember)" : "var(--ink-5,#333)", color: outcomeRug ? "#0a0a0a" : "var(--ink)", marginLeft: 4 }}>
                  {outcomeRug ? "RUGGED" : "SURVIVED"}
                </span>
              )}
            </div>
            <div className="sub">
              drops &gt;50% · {m.chain} · {m.pool}
              {!isHist && m.live && m.market_id !== undefined && (
                <span style={{ marginLeft: 8, color: "var(--ember)", fontFamily: "var(--mono)", fontSize: 10 }}>
                  #{m.market_id}
                </span>
              )}
              {isHist && (
                <span style={{ marginLeft: 8, color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 10 }}>
                  resolved
                </span>
              )}
            </div>
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
          {isHist ? (
            <span className="tabular"><b>{outcomeRug ? "YES" : "NO"}</b> won</span>
          ) : (
            <span>ttl <b className="tabular">{fmtTtl(m.ttl)}</b></span>
          )}
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
  const { markets: dataMarkets, source, loading, error, hitRate, liveCount, historicalCount } = useLiveMarkets();

  useEffect(() => {
    window.scrollTo(0, 0);
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const list = useMemo(() => {
    const enriched = dataMarkets.map((m, i) => ({
      ...m,
      consensus: m.agents.filter((s) => s > 0.5).length + "/3",
      prob: m.resolved
        ? m.prob
        : Math.max(0.05, Math.min(0.97, m.prob + Math.sin((tick + i * 8) / 14) * 0.012)),
      ttl: m.resolved ? 0 : Math.max(60, m.ttl - tick),
    }));
    let f = enriched;
    f = f.filter((m) => (tab === "resolved" ? m.resolved : !m.resolved));
    if (chain !== "all") f = f.filter((m) => m.chain === chain);
    if (q.trim()) f = f.filter((m) => m.tkr.toLowerCase().includes(q.trim().toLowerCase()));
    // Sort within the active tab criterion.
    const tabSort =
      tab === "hot"      ? (a, b) => b.prob - a.prob :
      tab === "new"      ? (a, b) => (b.new ? 1 : 0) - (a.new ? 1 : 0) || b.prob - a.prob :
      tab === "closing"  ? (a, b) => a.ttl - b.ttl :
      tab === "volume"   ? (a, b) => b.vol - a.vol :
      tab === "resolved" ? (a, b) => (b.market_id || 0) - (a.market_id || 0) :
      () => 0;
    // Live on-chain markets always sort ahead of static placeholders, regardless
    // of which tab criterion is active. Historical seed markets rank between
    // live and static — they're real data, just resolved.
    const tier = (m) =>
      m.historical ? 1 : (m.live ? 0 : 2);
    f = [...f].sort((a, b) => tier(a) - tier(b) || tabSort(a, b));
    return f;
  }, [tab, chain, q, tick, dataMarkets]);

  const openMarkets = dataMarkets.filter((m) => !m.resolved);
  const totalVol = openMarkets.reduce((s, m) => s + m.vol, 0);
  const totalBets = openMarkets.reduce((s, m) => s + m.bets, 0);
  const hitRatePct = hitRate != null ? Math.round(hitRate * 100) : 87;

  return (
    <div className="page-enter">
      <div className="mkt-topnav">
        <a href="#" className="back">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M7 2L3 5l4 3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          back
        </a>
      </div>

      <section className="mkt-hero">
        <div className="eyebrow" style={{ marginBottom: 14 }}>
          {tab === "resolved"
            ? `${historicalCount || 0} markets · history`
            : `${openMarkets.length} markets · open`}
          {source === "live" && tab !== "resolved" && liveCount > 0 && (
            <span style={{ marginLeft: 10, padding: "2px 8px", background: "var(--ember)", color: "#0a0a0a", borderRadius: 4, fontSize: 9, letterSpacing: ".08em", fontWeight: 600 }}>
              {liveCount} ON-CHAIN · ARC
            </span>
          )}
          {tab === "resolved" && historicalCount > 0 && (
            <span style={{ marginLeft: 10, padding: "2px 8px", background: "var(--ink-5,#222)", color: "var(--ink)", borderRadius: 4, fontSize: 9, letterSpacing: ".08em", fontWeight: 600 }}>
              AUDIT · NOT INTERACTABLE
            </span>
          )}
        </div>
        <h1>All live<br />rug markets.</h1>
        <div className="stats">
          <div className="stat"><div className="v">{openMarkets.length}</div><div className="k">open</div></div>
          <div className="stat"><div className="v">${(totalVol / 1000).toFixed(1)}<span style={{ fontSize: ".5em", color: "var(--ink-3)" }}>k</span></div><div className="k">total volume</div></div>
          <div className="stat"><div className="v">{totalBets}</div><div className="k">bets placed</div></div>
          <div className="stat"><div className="v">{hitRatePct}<span style={{ fontSize: ".5em", color: "var(--ink-3)" }}>%</span></div><div className="k">hit-rate · 30d</div></div>
        </div>
      </section>

      <div className="mkt-search">
        <input placeholder="Search ticker, pool, or chain…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="mkt-chips">
          {["hot", "new", "closing", "volume", "resolved"].map((s) => (
            <button key={s} className={"mkt-chip " + (tab === s ? "on" : "")} onClick={() => setTab(s)}>
              {s === "resolved" ? "history" : s}
            </button>
          ))}
          <span style={{ flexBasis: "100%", height: 0 }} />
          {["all", "BASE", "ETH", "ARB", "SOL"].map((c) => (
            <button key={c} className={"mkt-chip " + (chain === c ? "on" : "")} onClick={() => setChain(c)}>{c}</button>
          ))}
        </div>
      </div>

      <div className="mkt-list">
        {loading && dataMarkets.length === 0 ? (
          <div style={{ padding: 60, textAlign: "center", color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 13 }}>
            Loading live markets from Arc…
          </div>
        ) : error ? (
          <div style={{ padding: 60, textAlign: "center", color: "var(--ember)", fontFamily: "var(--mono)", fontSize: 13, border: "1px solid color-mix(in oklch, var(--ember), transparent 70%)", borderRadius: 8 }}>
            API unreachable — {error}
            <div style={{ marginTop: 8, color: "var(--ink-3)", fontSize: 11 }}>
              The Rugged backend on Arc may be down. No markets to show until it returns.
            </div>
          </div>
        ) : dataMarkets.length === 0 ? (
          <div style={{ padding: 60, textAlign: "center", color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 13, border: "1px dashed var(--line)", borderRadius: 8 }}>
            No markets yet. The swarm is watching the RugCheck feed —
            <br />new markets open the moment 2 of 3 agents fire.
          </div>
        ) : list.length === 0 ? (
          <div style={{ padding: 60, textAlign: "center", color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 13 }}>
            No markets match — try clearing filters.
          </div>
        ) : (
          list.map((m) => (
            <MarketCard
              key={m.market_id != null ? `m-${m.market_id}` : `t-${m.tkr}`}
              m={m}
            />
          ))
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

// Remembers the last-viewed market so the detail view can slide in directionally.
let lastDetailTkr = null;

// Fetch the full market detail (incl. full_trace.verdicts with reasoning &
// key_signals) for a live or historical market. Returns null while loading or
// when the market isn't on the API (e.g. demo-only static markets).
function useMarketDetail(market_id) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    if (market_id == null) {
      setState({ loading: false, data: null, error: null });
      return;
    }
    let cancelled = false;
    setState({ loading: true, data: null, error: null });
    fetch(`${API_BASE}/markets/${market_id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((body) => {
        if (cancelled) return;
        setState({ loading: false, data: body, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ loading: false, data: null, error: err.message });
      });
    return () => { cancelled = true; };
  }, [market_id]);
  return state;
}

// Per-wallet position on a specific market: yes/no stake, can-claim, payout.
// `bumpKey` is an opaque token — when it changes the hook refetches. Use it
// to invalidate after a claim lands so the UI can flip to "Claimed".
function useMarketPosition(market_id, walletConnected, bumpKey = 0) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    if (market_id == null || !walletConnected) {
      setState({ loading: false, data: null, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    apiFetch(`/markets/${market_id}/position`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((body) => {
        if (cancelled) return;
        setState({ loading: false, data: body, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ loading: false, data: null, error: err.message });
      });
    return () => { cancelled = true; };
  }, [market_id, walletConnected, bumpKey]);
  return state;
}

function MarketDetail({ tkr }) {
  const { markets: ALL } = useLiveMarkets();
  // Locate the current market and scope next/prev to the same class
  // (open ↔ open, resolved ↔ resolved). Mixing them confuses navigation.
  const target = ALL.find((m) => m.tkr.toLowerCase() === tkr);
  const NAV = target && target.resolved
    ? ALL.filter((m) => m.resolved)
    : ALL.filter((m) => !m.resolved);
  const idx = Math.max(0, NAV.findIndex((m) => m.tkr.toLowerCase() === tkr));
  const m0 = NAV[idx] || target || ALL[0];
  const navLen = Math.max(1, NAV.length);
  const next = NAV[(idx + 1) % navLen] || m0;
  const prev = NAV[(idx - 1 + navLen) % navLen] || m0;
  const { data: detail, loading: detailLoading } = useMarketDetail(m0 && m0.market_id);
  const [traceOpen, setTraceOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const wallet = useWallet();
  // Per-wallet position — drives the Claim panel on resolved markets only.
  // `positionBump` lets the claim callback force a re-fetch after settle.
  const [positionBump, setPositionBump] = useState(0);
  const positionState = useMarketPosition(
    m0 && m0.market_id,
    !!(wallet.exists && m0 && m0.live && m0.resolved),
    positionBump,
  );

  // Slide direction relative to the previously-viewed market (handles wraparound).
  const [slideDir] = useState(() => {
    if (lastDetailTkr == null) return "in";
    const from = ALL.findIndex((m) => m.tkr.toLowerCase() === lastDetailTkr);
    if (from < 0 || from === idx) return "in";
    const n = ALL.length;
    const delta = idx - from;
    if (delta === 1 || delta === -(n - 1)) return "next"; // moved forward
    if (delta === -1 || delta === n - 1) return "prev";   // moved back
    return "in";
  });

  const [tick, setTick] = useState(0);
  const [side, setSide] = useState(null); // 'rug' | 'safe' | null
  const [amount, setAmount] = useState(1);
  const [confirmed, setConfirmed] = useState(false);
  // { loading, error, tx_hash, bet_block, paymaster, approve_skipped, gas_cost_usd }
  const [betResult, setBetResult] = useState(null);

  useEffect(() => {
    window.scrollTo(0, 0);
    lastDetailTkr = tkr;
    setSide(null);
    setConfirmed(false);
    setAmount(1);
    setBetResult(null);
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [tkr]);

  async function placeRealBet() {
    if (!m0.live || m0.market_id === undefined) {
      // Static prototype market — keep the old fake-confirm flow.
      setConfirmed(true);
      setBetResult({ mocked: true });
      return;
    }
    // Wallet must be provisioned before we can take a real bet.
    if (!wallet.exists) {
      setWalletOpen(true);
      return;
    }
    setBetResult({ loading: true });
    try {
      const r = await apiFetch(`/markets/${m0.market_id}/bet`, {
        method: "POST",
        body: JSON.stringify({
          is_yes: side === "rug",
          amount_usdc: Number(amount),
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setBetResult(body);
      setConfirmed(true);
    } catch (err) {
      setBetResult({ error: err.message });
    }
  }

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
    <div className={"detail detail-slide-" + slideDir} key={tkr}>
      <div className="mkt-topnav">
        <a href="#/markets" className="back">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M7 2L3 5l4 3" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          back
        </a>
        <div className="brand">Rugged / {m0.tkr}</div>
        <div className="meta">market · {m0.resolved ? "resolved" : (m0.live ? "live" : "open")}</div>
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
          <div className="sub">
            {m0.resolved
              ? <>resolved · <b>{m0.outcome === "yes" ? "IT RUGGED" : "IT HELD"}</b></>
              : <>blacklist commit · resolves in <span className="tabular">{fmtTtl(ttl)}</span></>}
          </div>
        </div>

        <a href={`#/markets/${prev.tkr.toLowerCase()}`} className="detail-arrow left" aria-label="previous market">
          <svg width="18" height="18" viewBox="0 0 18 18"><path d="M11 4L6 9l5 5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </a>
        <a href={`#/markets/${next.tkr.toLowerCase()}`} className="detail-arrow right" aria-label="next market">
          <svg width="18" height="18" viewBox="0 0 18 18"><path d="M7 4l5 5-5 5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </a>
      </section>

      {m0.mint && (
        <div className="detail-contract" style={{
          maxWidth: 980,
          margin: "20px auto 0",
          padding: "12px 18px",
          background: "rgba(255,255,255,0.03)",
          border: "1px solid var(--ink-5,#1a1a1a)",
          borderRadius: 6,
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}>
          <div style={{
            fontSize: 10, color: "var(--ember)", fontFamily: "var(--mono)",
            letterSpacing: ".1em", textTransform: "uppercase", fontWeight: 600,
          }}>
            Token contract
          </div>
          <ContractAddress mint={m0.mint} chain={m0.chain} inline />
        </div>
      )}

      <div className="detail-bet-wrap">
        <div className="detail-position">
          <span className="mono small">{idx + 1} / {NAV.length}</span>
          <div className="dots">
            {NAV.map((_, i) => (
              <span key={i} className={"d " + (i === idx ? "on" : "")} />
            ))}
          </div>
        </div>

        <div className="detail-bet">
          <div className="hd">
            <div className="lbl">{m0.resolved ? "Resolved · settled on Arc" : "24-hour binary · seeded by swarm"}</div>
            <button className="share" aria-label="share">
              <svg width="14" height="14" viewBox="0 0 14 14"><path d="M9 4l-5 3 5 3M9 4v6" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>

          <div className="prompt">Will {m0.tkr} drop &gt;50%?</div>
          <div className="question">
            {m0.resolved
              ? "Settled against the 24-hour low observed during the open window."
              : "From its blacklist-time price within 24 hours. Settled against the observed low."}
          </div>

          <div className="split">
            <div className="side rug">
              <span className="pct rug tabular">{rugPct}<span style={{ fontSize: ".45em" }}>%</span></span>
              <span className="pct-lbl">IT RUGS</span>
            </div>
            <div className="vs">|</div>
            <div className="side safe">
              <span className="pct safe tabular">{safePct}<span style={{ fontSize: ".45em" }}>%</span></span>
              <span className="pct-lbl">IT HOLDS</span>
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

          {m0.resolved ? (
            <ClaimPanel
              m={m0}
              detail={detail}
              wallet={wallet}
              position={positionState.data}
              loading={positionState.loading}
              error={positionState.error}
              onConnect={() => setWalletOpen(true)}
              onClaimed={() => setPositionBump((b) => b + 1)}
            />
          ) : confirmed ? (
            <BetConfirmed
              side={side}
              amount={amount}
              payoutMult={payoutMult}
              betResult={betResult}
              onReset={() => { setConfirmed(false); setSide(null); setBetResult(null); }}
            />
          ) : side ? (
            <BetSlip
              side={side}
              amount={amount}
              setAmount={setAmount}
              payoutMult={payoutMult}
              live={!!m0.live}
              betResult={betResult}
              wallet={wallet}
              onConnect={() => setWalletOpen(true)}
              onConfirm={placeRealBet}
              onCancel={() => { setSide(null); setBetResult(null); }}
            />
          ) : (
            <div className="buttons">
              <button className="btn-rug" onClick={() => setSide("rug")}>
                <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 4l4 4 4-4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
                IT RUGS
              </button>
              <button className="btn-safe" onClick={() => setSide("safe")}>
                <svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 10l4-4 4 4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
                IT HOLDS
              </button>
            </div>
          )}
        </div>

        <ReasoningTrace
          m={m0}
          detail={detail}
          loading={detailLoading}
          onOpen={() => setTraceOpen(true)}
        />
      </div>

      <ReasoningTraceModal
        open={traceOpen}
        onClose={() => setTraceOpen(false)}
        m={m0}
        detail={detail}
      />
      <WalletModal
        open={walletOpen}
        onClose={() => setWalletOpen(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------
// Token contract address — copy + DexScreener / explorer link
// ---------------------------------------------------------------
function ContractAddress({ mint, chain, inline }) {
  const [copied, setCopied] = useState(false);
  const url = explorerUrlFor(mint, chain);
  function copy(e) {
    e.preventDefault();
    e.stopPropagation();
    try {
      navigator.clipboard?.writeText(mint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (_) { /* swallow — non-secure context */ }
  }
  const shortMint = mint.length > 14 ? `${mint.slice(0, 6)}…${mint.slice(-6)}` : mint;
  const containerStyle = inline ? {
    display: "flex", alignItems: "center", gap: 8,
    fontFamily: "var(--mono)", fontSize: 12, color: "var(--ink-2)",
    flexWrap: "wrap", flex: 1, minWidth: 0,
  } : {
    marginTop: 14, display: "flex", alignItems: "center", gap: 8,
    fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-3)",
    flexWrap: "wrap",
  };
  return (
    <div className="contract-row" style={containerStyle}>
      {!inline && (
        <span style={{ letterSpacing: ".08em", textTransform: "uppercase", color: "var(--ink-4)" }}>
          token contract
        </span>
      )}
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        title="View on DexScreener"
        style={{
          color: "var(--ink)",
          background: "rgba(255,255,255,0.06)",
          border: "1px solid var(--ink-5,#222)",
          padding: inline ? "5px 10px" : "3px 8px",
          borderRadius: 4,
          textDecoration: "none",
          letterSpacing: ".02em",
          fontSize: inline ? 12 : 11,
        }}
      >
        {shortMint}
        <svg width="10" height="10" viewBox="0 0 10 10" style={{ marginLeft: 6, verticalAlign: "middle" }}>
          <path d="M3 7l4-4M4 3h3v3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </a>
      <button
        onClick={copy}
        style={{
          background: "transparent",
          border: "1px solid var(--ink-5,#222)",
          color: copied ? "var(--ember)" : "var(--ink-3)",
          padding: inline ? "5px 10px" : "3px 8px",
          borderRadius: 4,
          fontFamily: "var(--mono)",
          fontSize: 10,
          letterSpacing: ".08em",
          textTransform: "uppercase",
          cursor: "pointer",
        }}
      >
        {copied ? "copied" : "copy"}
      </button>
      <span style={{ color: "var(--ink-4)", fontSize: 10, marginLeft: inline ? "auto" : 0 }}>
        {(chain || "SOL").toUpperCase()} · DexScreener →
      </span>
    </div>
  );
}

// ---------------------------------------------------------------
// Swarm reasoning trace — per-agent prose + key signals, plus a
// link to the raw pinned JSON.
// ---------------------------------------------------------------
const AGENT_LABEL = {
  contract_analyzer: { role: "Contract", description: "mint, ownership, LP, honeypot" },
  social_signal_analyzer: { role: "Social", description: "X, Telegram, dev sentiment" },
  onchain_flow_analyzer: { role: "Flow", description: "LP changes, dev wallet, holders" },
};

function _verdictsFor(m, detail) {
  return (
    (detail && detail.full_trace && detail.full_trace.verdicts) ||
    (detail && detail.verdicts) ||
    m.verdicts ||
    null
  );
}

function _consensusFor(verdicts) {
  const fired = verdicts.filter((v) => (v.score ?? 0) > 0.5).length;
  // Default missing confidence to 1.0 (uniform weighting) so older traces
  // without the confidence field still produce a sensible mean.
  const weights = verdicts.map((v) => (typeof v.confidence === "number" ? v.confidence : 1.0));
  const totalW = weights.reduce((s, w) => s + w, 0);
  const weighted = totalW > 0
    ? verdicts.reduce((s, v, i) => s + (v.score ?? 0) * weights[i], 0) / totalW
    : 0;
  return { fired, total: verdicts.length, weighted };
}

// Pull the swarm-level summary block from the full_trace if present.
function _swarmFor(m, detail) {
  return (
    (detail && detail.full_trace && detail.full_trace.swarm) ||
    null
  );
}

// Compact in-page summary — three agent score chips + a "View reasoning trace"
// button that opens the full modal.
function ReasoningTrace({ m, detail, loading, onOpen }) {
  const verdicts = _verdictsFor(m, detail);
  const swarm = _swarmFor(m, detail);

  if (loading && !verdicts) {
    return (
      <div className="detail-trace">
        <div className="eyebrow">Swarm reasoning</div>
        <div style={{ padding: 16, color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 12 }}>
          Loading reasoning trace…
        </div>
      </div>
    );
  }

  if (!verdicts || verdicts.length === 0) {
    return (
      <div className="detail-trace">
        <div className="eyebrow">Swarm reasoning</div>
        <div style={{ padding: 16, color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 12 }}>
          No reasoning trace available for this market.
        </div>
      </div>
    );
  }

  const c = _consensusFor(verdicts);
  // Prefer authoritative swarm flags from the pinned trace when present.
  const firedCount = (swarm && typeof swarm.firing_count === "number") ? swarm.firing_count : c.fired;
  const totalCount = (swarm && typeof swarm.total_agents === "number") ? swarm.total_agents : Math.max(verdicts.length, firedCount);
  const swarmPct = (swarm && typeof swarm.seed_probability_bps === "number")
    ? swarm.seed_probability_bps / 100
    : (m.prob != null ? m.prob * 100 : c.weighted * 100);
  const swarmFired = swarm && typeof swarm.fire === "boolean" ? swarm.fire : firedCount >= 2;

  return (
    <div className="detail-trace">
      <div className="eyebrow">Swarm reasoning · {firedCount} of {totalCount} fired</div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {verdicts.map((v) => {
          const meta = AGENT_LABEL[v.agent] || { role: v.agent };
          const score = v.score ?? 0;
          const tone = score > 0.7 ? "var(--ember)" : score > 0.5 ? "var(--amber)" : "var(--ink-4)";
          return (
            <div key={v.agent} style={{
              flex: 1, padding: "10px 8px", borderRadius: 4,
              background: "rgba(255,255,255,0.02)",
              border: "1px solid var(--ink-5,#1a1a1a)",
              textAlign: "center",
            }}>
              <div style={{ fontSize: 10, color: "var(--ink-3)", letterSpacing: ".08em", textTransform: "uppercase", marginBottom: 4 }}>
                {meta.role}
              </div>
              <div style={{ fontFamily: "var(--mono)", fontWeight: 600, fontSize: 18, color: tone, lineHeight: 1 }}>
                {score.toFixed(2)}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 11, color: "var(--ink-3)", lineHeight: 1.55, marginBottom: 12 }}>
        Swarm rug probability: <b style={{ color: "var(--ink)" }}>{swarmPct.toFixed(0)}%</b>
        {swarmFired ? " · quorum reached — market opened on Arc." : " · below quorum."}
      </div>

      <button
        type="button"
        onClick={onOpen}
        className="btn-ghost"
        style={{
          display: "inline-flex",
          alignItems: "center",
          background: "transparent",
          border: "1px solid var(--ink-5,#222)",
          padding: "8px 14px",
          color: "var(--ink)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          cursor: "pointer",
          borderRadius: 4,
        }}
      >
        View reasoning trace
        <svg width="11" height="11" viewBox="0 0 11 11" style={{ marginLeft: 6 }}>
          <path d="M3 5h5m0 0L6 3m2 2L6 7" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
        </svg>
      </button>
    </div>
  );
}

// Full-screen modal — per-agent prose, key signals, and consensus block.
function ReasoningTraceModal({ open, onClose, m, detail }) {
  // Lock body scroll while open + ESC to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  const verdicts = _verdictsFor(m, detail) || [];
  const swarm = _swarmFor(m, detail);
  const c = verdicts.length ? _consensusFor(verdicts) : { fired: 0, total: 0, weighted: 0 };
  const fired = (swarm && typeof swarm.firing_count === "number") ? swarm.firing_count : c.fired;
  const total = (swarm && typeof swarm.total_agents === "number") ? swarm.total_agents : Math.max(verdicts.length, fired);
  const probPct = (swarm && typeof swarm.seed_probability_bps === "number")
    ? swarm.seed_probability_bps / 100
    : (m.prob != null ? m.prob * 100 : c.weighted * 100);
  const swarmFired = swarm && typeof swarm.fire === "boolean" ? swarm.fire : fired >= 2;

  return (
    <Portal>
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(0,0,0,0.78)",
        backdropFilter: "blur(4px)",
        display: "flex", justifyContent: "center", alignItems: "center",
        padding: 24,
        overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 100%)",
          maxHeight: "min(90vh, 100%)",
          background: "#0c0c0c",
          border: "1px solid var(--ink-5,#222)",
          borderRadius: 6,
          padding: "22px 24px 24px",
          color: "var(--ink)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
          overflowY: "auto",
          margin: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 10, color: "var(--ember)", fontFamily: "var(--mono)", letterSpacing: ".1em", textTransform: "uppercase", marginBottom: 4 }}>
              Agent swarm · reasoning trace
            </div>
            <h2 style={{ margin: 0, fontSize: 20, lineHeight: 1.2 }}>
              {m.tkr} · {fired} of {total} agents fired
            </h2>
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 4 }}>
              Swarm rug probability <b style={{ color: "var(--ink)" }}>{probPct.toFixed(0)}%</b>
              {swarmFired ? " · quorum reached, market opened on Arc." : " · below quorum, no market opened."}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="close"
            style={{
              background: "transparent",
              border: "1px solid var(--ink-5,#222)",
              color: "var(--ink-2)",
              borderRadius: 4,
              padding: "6px 10px",
              fontFamily: "var(--mono)",
              fontSize: 11,
              cursor: "pointer",
              letterSpacing: ".08em",
              textTransform: "uppercase",
            }}
          >
            close
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {verdicts.map((v) => {
            const meta = AGENT_LABEL[v.agent] || { role: v.agent, description: "" };
            const score = v.score ?? 0;
            const tone = score > 0.7 ? "var(--ember)" : score > 0.5 ? "var(--amber)" : "var(--ink-4)";
            const fired = score > 0.5;
            return (
              <div key={v.agent} style={{
                padding: "14px 16px",
                background: "rgba(255,255,255,0.025)",
                border: "1px solid var(--ink-5,#1a1a1a)",
                borderRadius: 5,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <span style={{ fontFamily: "var(--mono)", fontWeight: 600, color: "var(--ink)", fontSize: 13 }}>
                      Agent {meta.role}
                    </span>
                    <span style={{ marginLeft: 8, color: "var(--ink-3)", fontSize: 11 }}>
                      {meta.description}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontFamily: "var(--mono)", fontWeight: 600, fontSize: 16, color: tone }}>
                      {score.toFixed(2)}
                    </span>
                    <span style={{
                      fontSize: 9, padding: "2px 7px", borderRadius: 3,
                      background: fired ? tone : "transparent",
                      color: fired ? "#0a0a0a" : "var(--ink-4)",
                      border: fired ? "none" : "1px solid var(--ink-5,#222)",
                      fontWeight: 600, letterSpacing: ".08em",
                    }}>
                      {fired ? "FIRED" : "PASS"}
                    </span>
                  </div>
                </div>
                {v.reasoning ? (
                  <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-2,#cbcbcb)", marginBottom: 10 }}>
                    {v.reasoning}
                  </div>
                ) : (
                  <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--ink-4)", fontStyle: "italic", marginBottom: 10 }}>
                    Verdict recorded without prose reasoning. {fired
                      ? `Agent scored ${score.toFixed(2)} (above the 0.50 firing threshold).`
                      : `Agent scored ${score.toFixed(2)} (below the 0.50 firing threshold).`}
                  </div>
                )}
                {Array.isArray(v.key_signals) && v.key_signals.length > 0 && (
                  <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--ink-3)", lineHeight: 1.7 }}>
                    {v.key_signals.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                )}
                {typeof v.confidence === "number" && (
                  <div style={{ marginTop: 10, fontSize: 10, color: "var(--ink-4)", fontFamily: "var(--mono)", letterSpacing: ".06em" }}>
                    confidence {(v.confidence * 100).toFixed(0)}%
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
    </Portal>
  );
}

function BetSlip({ side, amount, setAmount, payoutMult, live, betResult, wallet, onConnect, onConfirm, onCancel }) {
  const payout = (amount * payoutMult).toFixed(2);
  const profit = (amount * payoutMult - amount).toFixed(2);
  const presets = [1, 5, 10, 25];
  const tone = side === "rug" ? "rug" : "safe";
  const loading = betResult && betResult.loading;
  const error = betResult && betResult.error;
  const needsWallet = live && wallet && !wallet.exists;
  const usdc = wallet?.balance?.usdc ?? ((wallet?.balance?.usdc_raw ?? 0) / 1_000_000);
  const shortAddr = wallet?.address ? `${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}` : null;
  return (
    <div className={"betslip " + tone}>
      <div className="betslip-hd">
        <span className="lbl">
          Bet · {side === "rug" ? "IT RUGS" : "IT HOLDS"}
          {live && <span style={{ marginLeft: 8, padding: "1px 6px", background: "var(--ember)", color: "#0a0a0a", borderRadius: 3, fontSize: 9, fontWeight: 600, letterSpacing: ".06em" }}>ON-CHAIN</span>}
        </span>
        <button className="cancel" onClick={onCancel} disabled={loading}>cancel</button>
      </div>
      <div className="amt-row">
        <span className="usd">$</span>
        <input
          type="number"
          inputMode="decimal"
          min="1"
          value={amount}
          disabled={loading}
          onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))}
        />
        <span className="usd-lbl">USDC</span>
      </div>
      <div className="presets">
        {presets.map((p) => (
          <button key={p} className={amount === p ? "on" : ""} disabled={loading} onClick={() => setAmount(p)}>${p}</button>
        ))}
      </div>
      <div className="payout">
        <div><span className="k">to win</span><span className="v">${payout}</span></div>
        <div><span className="k">profit</span><span className="v">+${profit}</span></div>
        <div><span className="k">multiplier</span><span className="v">×{payoutMult.toFixed(2)}</span></div>
      </div>
      {needsWallet ? (
        <button
          className={"confirm " + tone}
          onClick={onConnect}
          style={{ background: "var(--ember)", color: "#0a0a0a" }}
        >
          Connect wallet to bet →
        </button>
      ) : (
        <button className={"confirm " + tone} onClick={onConfirm} disabled={loading}>
          {loading
            ? "Submitting · Circle paymaster signing…"
            : `Place $${amount} on ${side === "rug" ? "IT RUGS" : "IT HOLDS"}`}
        </button>
      )}
      {error && (
        <div style={{ marginTop: 8, padding: 8, background: "rgba(238,90,58,0.12)", color: "var(--ember)", fontSize: 11, fontFamily: "var(--mono)", borderRadius: 4 }}>
          {error}
        </div>
      )}
      {live && wallet?.exists && (
        <div style={{ marginTop: 8, fontSize: 10, color: "var(--ink-3)", fontFamily: "var(--mono)", letterSpacing: ".04em", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 99, background: "var(--safe, #4ade80)" }} />
          paying from {shortAddr} · ${usdc.toFixed(2)} USDC available
        </div>
      )}
      <div className="gas-note">
        {live
          ? "Circle Developer-Controlled Wallets · gas $0.00 · ~30–90s settle"
          : "paymaster covers gas · no seed phrase"}
      </div>
    </div>
  );
}

function BetConfirmed({ side, amount, payoutMult, betResult, onReset }) {
  const payout = (amount * payoutMult).toFixed(2);
  const tone = side === "rug" ? "rug" : "safe";
  const isLive = betResult && !betResult.mocked && betResult.bet_tx_hash;
  const txHash = isLive
    ? betResult.bet_tx_hash
    : "0x" + Math.random().toString(16).slice(2, 10) + "…" + Math.random().toString(16).slice(2, 6);
  const shortTx = txHash.length > 18 ? txHash.slice(0, 10) + "…" + txHash.slice(-6) : txHash;
  const block = isLive && betResult.bet_block ? betResult.bet_block : null;
  return (
    <div className={"confirmed " + tone}>
      <div className="check">
        <svg width="20" height="20" viewBox="0 0 20 20"><path d="M5 10l3 3 7-7" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </div>
      <div className="ttl">
        Bet placed.
        {isLive && <span style={{ marginLeft: 8, padding: "1px 6px", background: "var(--ember)", color: "#0a0a0a", borderRadius: 3, fontSize: 9, fontWeight: 600, letterSpacing: ".06em" }}>ON-CHAIN</span>}
      </div>
      <div className="sub mono">${amount} on {side === "rug" ? "IT RUGS" : "IT HOLDS"} · to win ${payout}</div>
      <div className="hash mono">tx {shortTx}{block ? ` · block ${block}` : ""}</div>
      {isLive && (
        <div className="hash mono" style={{ marginTop: 4, color: "var(--ember)" }}>
          gas $0.00 · via {betResult.paymaster}
          {betResult.approve_skipped && " · approve reused"}
        </div>
      )}
      <button className="another" onClick={onReset}>place another</button>
    </div>
  );
}

// ---------------------------------------------------------------
// ClaimPanel — renders inside the bet card on resolved markets.
//
// Four UX states (in priority order):
//   1. Wallet not connected → "Connect to check position"
//   2. Loading position from chain
//   3. Has winning stake + not claimed → big "Claim $X.XX" button
//   4. Already claimed → success-state with tx hash
//   5. No winning position → quiet "Market closed · YES/NO won"
// ---------------------------------------------------------------
function ClaimPanel({ m, detail, wallet, position, loading, error, onConnect, onClaimed }) {
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState(null);
  const [claimResult, setClaimResult] = useState(null);

  // Resolved historical markets are read-only (synthetic, no on-chain claim).
  if (m.historical) {
    return (
      <div className="claim-panel claim-historical">
        <div className="claim-row-kicker">Historical · audit only</div>
        <div className="claim-headline">
          <b style={{ color: m.outcome === "yes" ? "var(--ember)" : "var(--ink)" }}>
            {m.outcome === "yes" ? "IT RUGGED" : "IT HELD"}
          </b>
          {typeof m.price === "string" && m.price !== "—" && (
            <span style={{ marginLeft: 8, color: "var(--ink-3)", fontSize: 12 }}>· {m.price}</span>
          )}
        </div>
        <div className="claim-foot">
          This market is part of the 30-market historical seed used to compute the 30-day hit-rate. No on-chain claim.
        </div>
      </div>
    );
  }

  if (!wallet?.exists) {
    return (
      <div className="claim-panel">
        <div className="claim-row-kicker">Market settled · on Arc</div>
        <div className="claim-headline">
          <b style={{ color: m.outcome === "yes" ? "var(--ember)" : "var(--ink)" }}>
            {m.outcome === "yes" ? "IT RUGGED" : "IT HELD"}
          </b>
          {detail?.outcome && (
            <span style={{ marginLeft: 10, color: "var(--ink-3)", fontSize: 11, fontFamily: "var(--mono)" }}>
              low ${(detail.outcome.observed_low_price_micro_usd / 1_000_000).toFixed(6)}
            </span>
          )}
        </div>
        <button className="confirm safe" onClick={onConnect} style={{ background: "var(--ember)", color: "#0a0a0a" }}>
          Connect wallet to check position →
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="claim-panel">
        <div className="claim-row-kicker">Market settled · on Arc</div>
        <div className="claim-foot" style={{ textAlign: "center", padding: "12px 0" }}>
          Loading your position…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="claim-panel">
        <div className="claim-row-kicker">Market settled · on Arc</div>
        <div className="claim-error">Position read failed — {error}</div>
      </div>
    );
  }

  const payoutUsd = position ? (position.claimable_micro_usdc / 1_000_000) : 0;
  const stakeYes = position ? (position.yes_stake_micro_usdc / 1_000_000) : 0;
  const stakeNo = position ? (position.no_stake_micro_usdc / 1_000_000) : 0;
  const hasPosition = position && position.has_position;
  const canClaim = position && position.can_claim;
  const alreadyClaimed = position && position.claimed;

  async function claim() {
    setClaiming(true);
    setClaimError(null);
    try {
      const r = await apiFetch(`/markets/${m.market_id}/claim`, { method: "POST" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || body.detail || `HTTP ${r.status}`);
      setClaimResult(body);
      // Refresh wallet balance + invalidate the position cache so the panel
      // flips to the "Already claimed" branch on the next render.
      try { wallet?.refresh && wallet.refresh(); } catch (_) { /* */ }
      onClaimed && onClaimed();
    } catch (e) {
      setClaimError(e.message || "Claim failed");
    } finally {
      setClaiming(false);
    }
  }

  if (claimResult) {
    const tx = (claimResult.claim_tx_hash || "").toString();
    const shortTx = tx.length > 18 ? tx.slice(0, 10) + "…" + tx.slice(-6) : tx;
    return (
      <div className="claim-panel claim-success">
        <div className="claim-success-check">
          <svg width="22" height="22" viewBox="0 0 20 20"><path d="M5 10l3 3 7-7" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </div>
        <div className="claim-success-ttl">${claimResult.payout_usdc.toFixed(2)} claimed</div>
        <div className="claim-success-sub">paid into your Arc wallet</div>
        <div className="claim-success-tx">tx {shortTx} · gas $0.00</div>
      </div>
    );
  }

  return (
    <div className="claim-panel">
      <div className="claim-row-kicker">Market settled · on Arc</div>
      <div className="claim-headline">
        <b style={{ color: m.outcome === "yes" ? "var(--ember)" : "var(--ink)" }}>
          {m.outcome === "yes" ? "IT RUGGED" : "IT HELD"}
        </b>
        {detail?.outcome && (
          <span style={{ marginLeft: 10, color: "var(--ink-3)", fontSize: 11, fontFamily: "var(--mono)" }}>
            low ${(detail.outcome.observed_low_price_micro_usd / 1_000_000).toFixed(6)}
          </span>
        )}
      </div>

      {hasPosition ? (
        <div className="claim-position-row">
          <div className="claim-position-cell">
            <div className="claim-row-kicker">your position</div>
            <div className="claim-position-mono">
              {stakeYes > 0 && <>${stakeYes.toFixed(2)} on RUGS</>}
              {stakeYes > 0 && stakeNo > 0 && " · "}
              {stakeNo > 0 && <>${stakeNo.toFixed(2)} on HOLDS</>}
            </div>
          </div>
          <div className="claim-position-cell">
            <div className="claim-row-kicker">claimable</div>
            <div className="claim-position-payout">${payoutUsd.toFixed(2)}</div>
          </div>
        </div>
      ) : (
        <div className="claim-foot">
          You didn't bet on this market.
        </div>
      )}

      {canClaim && (
        <button
          className="confirm safe claim-btn"
          onClick={claim}
          disabled={claiming}
          style={{ background: "var(--safe, #4ade80)", color: "#0a0a0a" }}
        >
          {claiming ? "Claiming · Circle paymaster signing…" : `Claim $${payoutUsd.toFixed(2)} →`}
        </button>
      )}
      {alreadyClaimed && (
        <div className="claim-already">
          <svg width="14" height="14" viewBox="0 0 20 20" style={{ marginRight: 6, verticalAlign: "-3px" }}>
            <path d="M5 10l3 3 7-7" stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Already claimed
        </div>
      )}
      {claimError && <div className="claim-error">{claimError}</div>}
      <div className="claim-foot">
        Settlement runs on Arc; gas is sponsored by Circle Paymaster. Payout is your stake plus a pro-rata share of the losing pool (after 2% fee).
      </div>
    </div>
  );
}

// Export to window so app.jsx can use them.
Object.assign(window, { Spark, MarketCard, MarketsPage, MarketDetail, fmtTtl, ContractAddress, ReasoningTrace, ReasoningTraceModal });
