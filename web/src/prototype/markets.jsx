import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import ReactDOM from "react-dom";
import qrcode from "qrcode-generator";

// Privy-driven smart-account wallet — replaces the Circle Developer-Controlled
// Wallets flow this file originally used. Same return shape as the legacy
// useWallet hook so the rest of the JSX below doesn't need to change.
import { usePrivyWallet as _usePrivyWallet } from "../hooks/usePrivyWallet";
// Sponsored UserOp helpers — bet/claim/cancel/withdraw routes that used to
// go through /api/markets/{id}/bet|claim|cancel now sign client-side and
// submit through the self-bundler.
import {
  placeBet as _smartPlaceBet,
  claimMarket as _smartClaim,
  cancelMarketBet as _smartCancel,
  transferUsdc as _smartTransferUsdc,
} from "../lib/smartBet";
import { ERC20_ABI } from "../abis";
import { CONTRACTS } from "../config";
import { publicClient as _viemPublic } from "../lib/viemClient";

// Compatibility shim: the prototype used the CDN's `window.qrcode` global.
if (typeof window !== "undefined" && !window.qrcode) {
  window.qrcode = qrcode;
}

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

// Public wallet hook — used by every component in this file. Backed by
// Privy + SimpleAccount via ../hooks/usePrivyWallet.ts. The legacy Circle
// Developer-Controlled Wallet flow is gone; callers that expected `.id` /
// `.wallet_set_id` from the old shape get null (those fields aren't used
// in the codebase anymore, but the prop forwarding paths still tolerate
// them gracefully).
function useWallet() {
  return _usePrivyWallet();
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
  { id: "bets", label: "My bets" },
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
  // Shared confirmation state — any copy-address button in the modal flips this
  // to render a centered toast that auto-dismisses.
  const [copyToast, setCopyToast] = useState(false);
  const copyToastTimer = useRef(null);
  const copyAddress = useCallback(() => {
    if (!w.address) return;
    try { navigator.clipboard?.writeText(w.address); } catch (_) { /* non-secure context */ }
    setCopyToast(true);
    if (copyToastTimer.current) clearTimeout(copyToastTimer.current);
    copyToastTimer.current = setTimeout(() => setCopyToast(false), 1600);
  }, [w.address]);
  useEffect(() => () => { if (copyToastTimer.current) clearTimeout(copyToastTimer.current); }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    // Reset to balance view every time the modal opens.
    setView("balance");
    setCopyToast(false);
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
  // Privy-driven copy. The "Reconnect" branch is kept for a familiar
  // returning-visitor message, even though under Privy login is the same
  // flow both times — the user signs in and the same smart-account address
  // is derived deterministically from their EOA owner.
  const connectBtnLabel = w.loading
    ? "Connecting…"
    : (isReturning ? "Sign back in" : "Sign in or connect wallet");
  const connectTitle = isReturning ? "Welcome back" : "Connect to bet";
  const connectSub = isReturning
    ? "Sign in with the same email — or reconnect the wallet you used last time. Your smart-account address and balance follow whichever signer you choose. Gas is sponsored by the Rugged Paymaster on every bet."
    : "Sign in with email and Privy provisions a smart-account wallet on Arc — no seed phrase, no extension. Already have a wallet? Connect MetaMask, Rabby, Coinbase, or any WalletConnect signer instead. Gas is sponsored by the Rugged Paymaster on every bet, claim, and cancel.";

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
          position: "relative",
        }}
      >
        {copyToast && (
          <div
            className="wallet-copy-toast"
            role="status"
            aria-live="polite"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>Wallet address copied</span>
          </div>
        )}
        <div className="wallet-modal-head">
          <div>
            <div className="wallet-modal-kicker">Privy · smart account · Arc</div>
            <h2 className="wallet-modal-title" id="wallet-dialog-title">
              {w.exists ? "Your wallet" : connectTitle}
            </h2>
            <div className="wallet-modal-sub">
              {w.exists
                ? "ERC-4337 smart account. You own the signer key via Privy; gas is sponsored by the Rugged Paymaster on every action."
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
                  onCopyAddress={copyAddress}
                />
              </div>
            )}
            {view === "bets" && (
              <div
                role="tabpanel"
                id="wallet-panel-bets"
                aria-labelledby="wallet-tab-bets"
                tabIndex={0}
              >
                <WalletBetsView onClose={onClose} />
              </div>
            )}
            {view === "deposit" && (
              <div
                role="tabpanel"
                id="wallet-panel-deposit"
                aria-labelledby="wallet-tab-deposit"
                tabIndex={0}
              >
                <WalletDepositView w={w} onCopyAddress={copyAddress} />
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
              <li>Email sign-in via <b>Privy</b> — no seed phrase, no extension</li>
              <li>Or connect your own wallet — <b>MetaMask</b>, <b>Rabby</b>, <b>Coinbase</b>, or <b>WalletConnect</b></li>
              <li>Gas sponsored by the <b>Rugged Paymaster</b> — bets, claims, cancels all $0.00</li>
              <li>Settlement on <b>Arc</b> · sub-second finality · USDC end-to-end</li>
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

function WalletBalanceView({ w, usdc, usyc, shortAddr, onClose, onCopyAddress }) {
  // Demo-faucet state — { loading, result, error }.
  const [faucet, setFaucet] = useState({ loading: false, result: null, error: null });
  // Export-wallet OTP gate state.
  //   "idle"        — show the trigger button
  //   "sending"     — Privy is emailing the code
  //   "awaiting"    — code sent; show the OTP input
  //   "verifying"   — OTP submitted; awaiting verification + key-modal handoff
  // The component returns to "idle" after the Privy export modal closes
  // (privyExportWallet's promise resolves on modal exit) or on cancel.
  const [exportStep, setExportStep] = useState("idle");
  const [exportCode, setExportCode] = useState("");
  const [exportError, setExportError] = useState(null);

  async function startExport() {
    if (!w.requestExportCode || exportStep !== "idle") return;
    setExportError(null);
    setExportCode("");
    setExportStep("sending");
    try {
      await w.requestExportCode();
      setExportStep("awaiting");
    } catch (e) {
      setExportError(e?.message || "Could not send verification code");
      setExportStep("idle");
    }
  }

  async function submitExportCode(e) {
    if (e) e.preventDefault();
    if (!w.verifyExportCodeAndReveal || exportStep !== "awaiting") return;
    if (!exportCode.trim()) {
      setExportError("Enter the 6-digit code from your email");
      return;
    }
    setExportError(null);
    setExportStep("verifying");
    try {
      await w.verifyExportCodeAndReveal(exportCode);
      // Privy's export modal has closed (its promise resolved). Reset.
      setExportCode("");
      setExportStep("idle");
    } catch (err) {
      setExportError(err?.message || "Invalid code — try again");
      setExportStep("awaiting");
    }
  }

  function cancelExport() {
    setExportStep("idle");
    setExportCode("");
    setExportError(null);
  }

  async function claimFaucet() {
    if (faucet.loading) return;
    setFaucet({ loading: true, result: null, error: null });
    try {
      const r = await apiFetch("/wallet/faucet", { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || body.detail || `HTTP ${r.status}`);
      setFaucet({ loading: false, result: body, error: null });
      w.refresh();
    } catch (e) {
      setFaucet({ loading: false, result: null, error: e.message });
    }
  }

  return (
    <>
      <div className="wallet-address-row">
        <div className="wallet-row-kicker">address</div>
        <div className="wallet-address-line">
          <span className="wallet-address-mono">{shortAddr}</span>
          <button
            type="button"
            className="btn-pill wallet-copy"
            onClick={onCopyAddress}
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

      <div className="wallet-faucet-row">
        <button
          type="button"
          onClick={claimFaucet}
          disabled={faucet.loading}
          className="wallet-faucet-btn"
        >
          {faucet.loading
            ? "Sending $10 testnet USDC…"
            : faucet.result
              ? `+$${faucet.result.amount_usdc.toFixed(0)} USDC sent`
              : "Get $10 testnet USDC"}
        </button>
        {faucet.error && (
          <div className="wallet-faucet-msg wallet-faucet-msg--error">{faucet.error}</div>
        )}
        {faucet.result && (
          <div className="wallet-faucet-msg">
            Sent at block {faucet.result.block_number}. 1 claim per hour.
          </div>
        )}
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

      {w.requestExportCode && (
        <div className="wallet-export-row">
          <div className="wallet-export-meta">
            <div className="wallet-row-kicker">Advanced · private key</div>
            <div className="wallet-export-hint">
              Export the embedded EOA signer's private key (the EOA, not the
              smart account — the EOA address may differ from the one shown
              above). We'll email a 6-digit code to <b>{w.exportEmail}</b> for
              verification, then open Privy's iframe-isolated reveal modal.
            </div>
            {exportStep === "idle" && (
              <div className="wallet-export-hint wallet-export-hint--inset">
                <b>In the Privy modal:</b> click the large primary button
                labeled <i>“Copy key”</i> — that copies the 64-char private key
                to your clipboard. The smaller icon-button next to the wallet
                address copies the <i>address</i>, not the key. A correct paste
                starts with <code>0x</code> and is <b>66 characters total</b>;
                a 42-char paste means you copied the address.
              </div>
            )}
          </div>

          {exportStep === "idle" && (
            <button
              type="button"
              onClick={startExport}
              disabled={w.loading}
              className="wallet-secondary-btn wallet-export-btn"
              title="Reveals the EOA private key behind your smart account. Requires email verification."
            >
              Export wallet
            </button>
          )}

          {exportStep === "sending" && (
            <button
              type="button"
              disabled
              className="wallet-secondary-btn wallet-export-btn"
            >
              Sending code…
            </button>
          )}

          {(exportStep === "awaiting" || exportStep === "verifying") && (
            <form className="wallet-export-otp" onSubmit={submitExportCode}>
              <label className="wallet-row-kicker" htmlFor="wallet-export-code">
                Code sent to {w.exportEmail}
              </label>
              <input
                id="wallet-export-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="• • • • • •"
                value={exportCode}
                onChange={(e) => setExportCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                disabled={exportStep === "verifying"}
                className="wallet-input wallet-export-otp-input"
                autoFocus
                aria-label="6-digit verification code"
              />
              <button
                type="submit"
                disabled={exportStep === "verifying" || exportCode.length < 6}
                className="wallet-primary-btn wallet-export-verify-btn"
              >
                {exportStep === "verifying" ? "Verifying…" : "Verify & reveal key"}
              </button>
              <div className="wallet-export-otp-actions">
                <button
                  type="button"
                  onClick={cancelExport}
                  disabled={exportStep === "verifying"}
                  className="wallet-export-link"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={startExport}
                  disabled={exportStep === "verifying"}
                  className="wallet-export-link"
                >
                  Resend code
                </button>
              </div>
            </form>
          )}

          {exportError && (
            <div className="wallet-export-error">{exportError}</div>
          )}
        </div>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────
// WalletBetsView — list of every market this wallet has a stake on.
// Backed by GET /api/wallet/positions, which walks the factory once
// and returns only markets with a non-zero stake.
//
// Rows link to the market detail page so the user can claim from
// there once a market resolves. Resolved/winning rows are visually
// highlighted; claimable rows surface the payout amount.
// ─────────────────────────────────────────────────────────────────
function WalletBetsView({ onClose }) {
  const [state, setState] = useState({ loading: true, positions: [], error: null });

  useEffect(() => {
    let cancelled = false;
    apiFetch("/wallet/positions")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
      .then((body) => {
        if (cancelled) return;
        setState({ loading: false, positions: body.positions || [], error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ loading: false, positions: [], error: err.message });
      });
    return () => { cancelled = true; };
  }, []);

  function fmtUsd(n) {
    const v = Number(n) || 0;
    return v.toFixed(v < 10 ? 2 : 0);
  }

  if (state.loading) {
    return (
      <div className="wallet-bets-empty">
        <span style={{ color: "var(--ink-3)", fontFamily: "var(--mono)", fontSize: 12 }}>
          Loading your bets…
        </span>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="wallet-bets-empty">
        <span style={{ color: "var(--ember)", fontFamily: "var(--mono)", fontSize: 12 }}>
          Couldn't load bets — {state.error}
        </span>
      </div>
    );
  }
  if (state.positions.length === 0) {
    return (
      <div className="wallet-bets-empty">
        <div style={{ color: "var(--ink-2)", marginBottom: 6 }}>No bets yet.</div>
        <div style={{ color: "var(--ink-3)", fontSize: 12, lineHeight: 1.5 }}>
          Pick a market from the list and stake on <b>IT RUGS</b> or <b>IT HOLDS</b>.
          Your positions show up here.
        </div>
      </div>
    );
  }

  return (
    <ul className="wallet-bets-list">
      {state.positions.map((p) => {
        const total = p.yes_stake_usdc + p.no_stake_usdc;
        const dominantSide = p.yes_stake_micro_usdc >= p.no_stake_micro_usdc ? "rug" : "safe";
        // Status pill copy
        let statusLbl, statusCls;
        if (!p.resolved) {
          statusLbl = "open";
          statusCls = "amber";
        } else if (p.claimed) {
          statusLbl = "claimed";
          statusCls = "dim";
        } else if (p.can_claim) {
          statusLbl = `claim $${fmtUsd(p.claimable_usdc)}`;
          statusCls = "ember";
        } else if (p.is_winner) {
          statusLbl = "winner";
          statusCls = "ember";
        } else {
          statusLbl = p.yes_won === true ? "yes won" : p.yes_won === false ? "no won" : "resolved";
          statusCls = "dim";
        }
        const href = `#/markets/${(p.symbol || p.market_address.slice(2, 8)).toLowerCase()}`;
        return (
          <li key={p.market_id} className="wallet-bet-row">
            <a
              href={href}
              onClick={onClose}
              className="wallet-bet-link"
            >
              <div className="wallet-bet-head">
                <span className="wallet-bet-sym">
                  {p.symbol ? p.symbol : `#${p.market_id}`}
                </span>
                <span className={"wallet-bet-status " + statusCls}>
                  {statusLbl}
                </span>
              </div>
              <div className="wallet-bet-body">
                <span className={"wallet-bet-side " + dominantSide}>
                  {dominantSide === "rug" ? "IT RUGS" : "IT HOLDS"}
                </span>
                <span className="wallet-bet-amt">
                  ${fmtUsd(total)} <span className="wallet-bet-amt-lbl">staked</span>
                </span>
              </div>
              {p.yes_stake_micro_usdc > 0 && p.no_stake_micro_usdc > 0 && (
                <div className="wallet-bet-split">
                  RUGS ${fmtUsd(p.yes_stake_usdc)} · HOLDS ${fmtUsd(p.no_stake_usdc)}
                </div>
              )}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function WalletDepositView({ w, onCopyAddress }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    onCopyAddress?.();
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
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
      if (!w.client) throw new Error("Smart account not ready");
      const amountMicro = BigInt(Math.round(amountNum * 1_000_000));
      const r = await _smartTransferUsdc(w.client, to.trim(), amountMicro);
      setResult({
        from: w.address,
        to: to.trim(),
        amount_usdc: amountNum,
        withdraw_tx_hash: r.txHash,
        withdraw_block: r.blockNumber,
        paymaster: "rugged-paymaster",
      });
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
        ${usdc.toFixed(2)} USDC available · gas sponsored by Rugged Paymaster ($0.00)
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

// Renders a compact "Your position" panel directly under the bet card
// on open markets. Shows yes/no stake amounts and the total exposure.
// Rendering only when has_position is true is the caller's responsibility.
function YourPositionStrip({ position, marketId, marketAddress, client, onAddMore, onCancelled }) {
  const yes = position.yes_stake_micro_usdc / 1_000_000;
  const no = position.no_stake_micro_usdc / 1_000_000;
  const total = yes + no;
  const fmt = (v) => (v < 10 ? v.toFixed(2) : v.toFixed(0));

  // Per-leg cancel state — { side: 'rug' | 'safe' | null, error: string | null }
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  // Cancel confirmation modal — null when closed, { isYes, amount } when open.
  const [confirmTarget, setConfirmTarget] = useState(null);

  function openCancelConfirm(isYes) {
    if (busy) return;
    setError(null);
    setConfirmTarget({ isYes, amount: isYes ? yes : no });
  }

  async function performCancel(isYes) {
    setBusy(isYes ? "rug" : "safe");
    setError(null);
    setConfirmTarget(null);
    try {
      if (!client) throw new Error("Wallet not ready");
      if (!marketAddress) throw new Error("Market address unavailable");
      // Smart-account cancelBet: signs client-side, sponsored by RuggedPaymaster.
      // Returns once the UserOp lands on-chain. Throws if anything fails.
      await _smartCancel(client, marketAddress, !!isYes);
      onCancelled?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="your-position">
      <div className="yp-head">
        <span className="yp-kicker">Your position</span>
        <span className="yp-total">${fmt(total)}<span className="yp-total-lbl"> total staked</span></span>
      </div>
      <div className="yp-split">
        {yes > 0 && (
          <div className="yp-leg rug">
            <div className="yp-leg-row">
              <span className="yp-leg-lbl">IT RUGS</span>
              <span className="yp-leg-amt">${fmt(yes)}</span>
            </div>
            <div className="yp-leg-actions">
              <button
                type="button"
                className="yp-btn yp-add"
                onClick={() => onAddMore?.("rug")}
                disabled={!!busy}
              >
                + Add more
              </button>
              <button
                type="button"
                className="yp-btn yp-cancel"
                onClick={() => openCancelConfirm(true)}
                disabled={!!busy}
              >
                {busy === "rug" ? "Cancelling…" : "Cancel bet"}
              </button>
            </div>
          </div>
        )}
        {no > 0 && (
          <div className="yp-leg safe">
            <div className="yp-leg-row">
              <span className="yp-leg-lbl">IT HOLDS</span>
              <span className="yp-leg-amt">${fmt(no)}</span>
            </div>
            <div className="yp-leg-actions">
              <button
                type="button"
                className="yp-btn yp-add"
                onClick={() => onAddMore?.("safe")}
                disabled={!!busy}
              >
                + Add more
              </button>
              <button
                type="button"
                className="yp-btn yp-cancel"
                onClick={() => openCancelConfirm(false)}
                disabled={!!busy}
              >
                {busy === "safe" ? "Cancelling…" : "Cancel bet"}
              </button>
            </div>
          </div>
        )}
      </div>
      {error && <div className="yp-error">Couldn't cancel — {error}</div>}
      <div className="yp-foot">
        Add to your position any time, or cancel for a full refund while the
        market is open. Gas sponsored on both. Settles automatically at expiry.
      </div>
      <CancelConfirmModal
        target={confirmTarget}
        onClose={() => setConfirmTarget(null)}
        onConfirm={() => performCancel(confirmTarget.isYes)}
      />
    </div>
  );
}

// Confirmation modal for cancelling a position leg. Portal-rendered so the
// backdrop covers the whole viewport, not just the bet card.
//   target  — null when closed, { isYes, amount } when open.
//   onClose — bound to Escape + backdrop click + Keep bet.
//   onConfirm — called when the user confirms; caller fires the API call.
function CancelConfirmModal({ target, onClose, onConfirm }) {
  useEffect(() => {
    if (!target) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [target, onClose]);

  if (!target) return null;
  const sideName = target.isYes ? "IT RUGS" : "IT HOLDS";
  const sideTone = target.isYes ? "rug" : "safe";
  const fmt = (v) => (v < 10 ? v.toFixed(2) : v.toFixed(0));

  return (
    <Portal>
      <div
        className="yp-confirm-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="yp-confirm-title"
        onClick={onClose}
      >
        <div
          className="yp-confirm-card"
          onClick={(e) => e.stopPropagation()}
          role="document"
        >
          <div className="yp-confirm-kicker">Cancel position</div>
          <h2 id="yp-confirm-title" className="yp-confirm-title">
            Refund your <span className={"yp-confirm-side " + sideTone}>{sideName}</span> bet?
          </h2>
          <div className="yp-confirm-amount">
            <span className="yp-confirm-amount-val">${fmt(target.amount)}</span>
            <span className="yp-confirm-amount-lbl">USDC returns to your wallet</span>
          </div>
          <ul className="yp-confirm-list">
            <li>Full refund — no fees on cancel</li>
            <li>Gas sponsored by Circle paymaster</li>
            <li>You can re-enter the market anytime before expiry</li>
          </ul>
          <div className="yp-confirm-actions">
            <button type="button" className="yp-confirm-btn ghost" onClick={onClose}>
              Keep bet
            </button>
            <button
              type="button"
              className={"yp-confirm-btn primary " + sideTone}
              onClick={onConfirm}
              autoFocus
            >
              Cancel + refund ${fmt(target.amount)}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
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
  // Fetch position whenever the wallet is connected to a live market —
  // resolved AND open. ClaimPanel uses it on resolved markets; the
  // "Your position" strip below the bet card uses it on open ones.
  const positionState = useMarketPosition(
    m0 && m0.market_id,
    !!(wallet.exists && m0 && m0.live),
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
      if (!wallet.client) throw new Error("Smart account not ready");
      if (!m0.market_address) throw new Error("Market address unavailable");
      const amountMicro = BigInt(Math.round(Number(amount) * 1_000_000));
      // Read current allowance so we can skip approve when it already covers
      // the bet amount (e.g. the user just added more on the same market).
      let allowance = 0n;
      try {
        allowance = (await _viemPublic.readContract({
          address: CONTRACTS.usdc,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [wallet.address, m0.market_address],
        })) ?? 0n;
      } catch (_) { /* defensive — treat as 0 */ }

      const result = await _smartPlaceBet(wallet.client, {
        marketAddress: m0.market_address,
        isYes: side === "rug",
        amountMicroUsdc: amountMicro,
        currentAllowance: allowance,
      });

      setBetResult({
        approve_skipped: result.approve === null,
        approve_tx_hash: result.approve?.txHash ?? null,
        bet_tx_hash: result.bet.txHash,
        bet_block: result.bet.blockNumber,
        gas_cost_usd: 0,
        paymaster: "rugged-paymaster (on-chain scope-checked)",
      });
      setConfirmed(true);
      wallet.refresh?.();
      // Refetch the position so the "Your position" strip updates with the
      // freshly-recorded stake.
      setPositionBump((b) => b + 1);
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

        {/* Your position strip — only on open markets that the user has bet
            on. Resolved markets show position info inside ClaimPanel
            already, so we'd duplicate it otherwise. */}
        {!m0.resolved && positionState.data?.has_position && (
          <YourPositionStrip
            position={positionState.data}
            marketId={m0.market_id}
            marketAddress={positionState.data.market_address || m0.market_address}
            client={wallet.client}
            onAddMore={(s) => {
              // Re-open the BetSlip on the same side the user is already on.
              setSide(s);
              setConfirmed(false);
              setBetResult(null);
              setAmount(1);
            }}
            onCancelled={() => setPositionBump((b) => b + 1)}
          />
        )}

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
  // Local string state for the amount input so the field can be cleared
  // entirely (empty string) without snapping back to 1. The parent's `amount`
  // is the last-known-valid number — only sync when the input parses to a
  // valid bet (≥ $1). Below the minimum or empty, surface an inline error
  // and disable confirm.
  const [inputStr, setInputStr] = useState(String(amount));
  useEffect(() => {
    // Keep the field in sync when amount changes from outside (preset clicks,
    // "Add more" from YourPositionStrip, etc.).
    setInputStr(String(amount));
  }, [amount]);

  const parsed = inputStr === "" ? NaN : Number(inputStr);
  const hasValue = inputStr !== "" && !Number.isNaN(parsed);
  const belowMin = hasValue && parsed < 1;
  const isValid = hasValue && parsed >= 1;
  // Show the error once the user has typed something below $1; an empty
  // field is a blank-slate "still typing" state, not yet an error.
  const showError = belowMin;
  // Drive the payout panel from whatever's currently in the field so the
  // numbers feel live as the user types.
  const displayAmount = hasValue && parsed >= 0 ? parsed : 0;
  const payout = (displayAmount * payoutMult).toFixed(2);
  const profit = (displayAmount * payoutMult - displayAmount).toFixed(2);
  const presets = [1, 5, 10, 25];
  const tone = side === "rug" ? "rug" : "safe";
  const loading = betResult && betResult.loading;
  const error = betResult && betResult.error;
  const needsWallet = live && wallet && !wallet.exists;
  const usdc = wallet?.balance?.usdc ?? ((wallet?.balance?.usdc_raw ?? 0) / 1_000_000);
  const shortAddr = wallet?.address ? `${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}` : null;

  function handleAmountChange(e) {
    const v = e.target.value;
    setInputStr(v);
    // Only propagate to parent when the value is a valid bet — keeps placeRealBet
    // from ever firing with sub-minimum amounts. Below-min / empty values stay
    // local so the user can edit freely.
    const n = Number(v);
    if (v !== "" && !Number.isNaN(n) && n >= 1) setAmount(n);
  }

  return (
    <div className={"betslip " + tone}>
      <div className="betslip-hd">
        <span className="lbl">
          Bet · {side === "rug" ? "IT RUGS" : "IT HOLDS"}
          {live && <span style={{ marginLeft: 8, padding: "1px 6px", background: "var(--ember)", color: "#0a0a0a", borderRadius: 3, fontSize: 9, fontWeight: 600, letterSpacing: ".06em" }}>ON-CHAIN</span>}
        </span>
        <button className="cancel" onClick={onCancel} disabled={loading}>cancel</button>
      </div>
      <div className={"amt-row" + (showError ? " has-error" : "")}>
        <span className="usd">$</span>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={inputStr}
          disabled={loading}
          onChange={handleAmountChange}
          aria-invalid={showError ? "true" : "false"}
          aria-describedby={showError ? "betslip-min-error" : undefined}
        />
        <span className="usd-lbl">USDC</span>
      </div>
      {showError && (
        <div id="betslip-min-error" className="amt-error" role="alert">
          Minimum bet is $1
        </div>
      )}
      <div className="presets">
        {presets.map((p) => (
          <button key={p} className={isValid && parsed === p ? "on" : ""} disabled={loading} onClick={() => { setInputStr(String(p)); setAmount(p); }}>${p}</button>
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
        <button className={"confirm " + tone} onClick={onConfirm} disabled={loading || !isValid}>
          {loading
            ? "Submitting · Circle paymaster signing…"
            : isValid
              ? `Place $${parsed} on ${side === "rug" ? "IT RUGS" : "IT HOLDS"}`
              : `Enter at least $1 to bet`}
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
          ? "Privy smart account · gas sponsored by Rugged Paymaster · $0.00"
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
      if (!wallet?.client) throw new Error("Smart account not ready");
      const marketAddr = position?.market_address || m.market_address;
      if (!marketAddr) throw new Error("Market address unavailable");
      const result = await _smartClaim(wallet.client, marketAddr);
      setClaimResult({
        claim_tx_hash: result.txHash,
        claim_block: result.blockNumber,
        payout_micro_usdc: position?.claimable_micro_usdc ?? 0,
        payout_usdc: (position?.claimable_micro_usdc ?? 0) / 1_000_000,
        paymaster: "rugged-paymaster",
      });
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
        Settlement runs on Arc; gas is sponsored by the Rugged Paymaster. Payout is your stake plus a pro-rata share of the losing pool (after 2% fee).
      </div>
    </div>
  );
}

// Export to window so app.jsx can use them.
Object.assign(window, { Spark, MarketCard, MarketsPage, MarketDetail, fmtTtl, ContractAddress, ReasoningTrace, ReasoningTraceModal });
