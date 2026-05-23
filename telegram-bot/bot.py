"""Rugged · Telegram alert bot (Phase 7).

Two responsibilities:

1. **Commands** — /start, /markets, /mybets, /bond.
2. **Alerts** — background poll of the API for newly opened markets and
   pushes a one-tap "RUG IT / SAVE IT" card to every subscribed chat.

Talks to the local Rugged API (FastAPI) for all data; no chain reads here.
Subscribers (chat_ids) are persisted in `data/telegram_subscribers.json` so
restarts are non-destructive.

Run:
    uv run python -m telegram-bot.bot                  # foreground

Env (see .env.example):
    TELEGRAM_BOT_TOKEN     — required, from @BotFather
    RUGGED_API_BASE        — default http://127.0.0.1:8000
    RUGGED_WEB_BASE        — default http://127.0.0.1:8000 (one-tap bet link host)
    TELEGRAM_POLL_SECONDS  — default 20 (new-market alert poll interval)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env", override=True)

try:
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
    from telegram.constants import ChatAction, ParseMode
    from telegram.ext import (
        Application,
        CommandHandler,
        ContextTypes,
    )
except ImportError as exc:  # pragma: no cover — surfaced cleanly without the dep
    raise SystemExit(
        "python-telegram-bot is required. Install with `uv sync` or "
        "`uv add python-telegram-bot>=21`. ({})".format(exc)
    )

log = logging.getLogger("telegram-bot")


# ----------------------------------------------------------------------
#  Config
# ----------------------------------------------------------------------
API_BASE = os.environ.get("RUGGED_API_BASE", "http://127.0.0.1:8000").rstrip("/")
WEB_BASE = os.environ.get("RUGGED_WEB_BASE", "http://127.0.0.1:8000").rstrip("/")
POLL_SECONDS = int(os.environ.get("TELEGRAM_POLL_SECONDS", "20"))
SUBSCRIBERS_PATH = ROOT / "data" / "telegram_subscribers.json"
ALERTED_PATH = ROOT / "data" / "telegram_alerted_markets.json"


# ----------------------------------------------------------------------
#  Persisted state — subscribers + already-alerted market ids
# ----------------------------------------------------------------------
def _load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True))


def _subscribers() -> set[int]:
    return set(_load_json(SUBSCRIBERS_PATH, []))


def _save_subscribers(subs: set[int]) -> None:
    _save_json(SUBSCRIBERS_PATH, sorted(subs))


def _alerted_ids() -> set[int]:
    return set(_load_json(ALERTED_PATH, []))


def _save_alerted(ids: set[int]) -> None:
    _save_json(ALERTED_PATH, sorted(ids))


def add_subscriber(chat_id: int) -> bool:
    subs = _subscribers()
    if chat_id in subs:
        return False
    subs.add(chat_id)
    _save_subscribers(subs)
    return True


def remove_subscriber(chat_id: int) -> bool:
    subs = _subscribers()
    if chat_id not in subs:
        return False
    subs.discard(chat_id)
    _save_subscribers(subs)
    return True


# ----------------------------------------------------------------------
#  API client — thin httpx wrapper
# ----------------------------------------------------------------------
class RuggedAPI:
    def __init__(self, base: str = API_BASE, timeout: float = 30.0) -> None:
        # 30s default — the chain-read enrichment in /api/markets can take
        # 10–20s on a cold cache (one RPC per market). The API caches for 10s,
        # so subsequent polls return instantly.
        self.base = base
        self.timeout = timeout

    async def _get(self, path: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.get(f"{self.base}{path}")
            r.raise_for_status()
            return r.json()

    async def markets(self) -> list[dict[str, Any]]:
        body = await self._get("/api/markets")
        return body.get("markets", []) or []

    async def stats(self) -> dict[str, Any]:
        return await self._get("/api/stats")

    # NOTE: the old single-shared `/api/demo-wallet` endpoint was removed
    # when the wallet system became per-user (X-Rugged-User-Id, then Privy
    # smart accounts). Telegram users don't have a stable web identity here,
    # so /mybets now just deep-links them to the web app where their wallet
    # lives. Method intentionally absent.


api = RuggedAPI()


# ----------------------------------------------------------------------
#  Formatting helpers
# ----------------------------------------------------------------------
def _fmt_mint(mint: str | None) -> str:
    if not mint or len(mint) < 10:
        return mint or "—"
    return f"{mint[:4]}…{mint[-4:]}"


def _ttl(expiry: int | None) -> str:
    if not expiry:
        return "—"
    secs = max(0, expiry - int(datetime.now(tz=timezone.utc).timestamp()))
    h, rem = divmod(secs, 3600)
    m, _ = divmod(rem, 60)
    return f"{h}h {m:02d}m"


def _market_link(market_id: int, tkr: str) -> str:
    return f"{WEB_BASE}/#/markets/{tkr.lower()}"


def _market_keyboard(market_id: int, tkr: str) -> InlineKeyboardMarkup:
    base = _market_link(market_id, tkr)
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("🔥 RUG IT", url=f"{base}?bet=rug"),
            InlineKeyboardButton("🛡 SAVE IT", url=f"{base}?bet=safe"),
        ],
        [InlineKeyboardButton("View market", url=base)],
    ])


def _market_card(m: dict[str, Any]) -> str:
    symbol = m.get("symbol", "RUGGED")
    chain = (m.get("chain") or "solana").upper()
    prob_bps = m.get("seed_probability_bps") or 0
    prob_pct = prob_bps / 100
    pool = (m.get("yes_pool", 0) + m.get("no_pool", 0)) / 1_000_000
    verdicts = m.get("verdicts") or (m.get("full_trace") or {}).get("verdicts") or []
    fired = sum(1 for v in verdicts if v.get("score", 0) > 0.5)
    agent_line = f"{fired}/{len(verdicts) or 3} agents above threshold"
    return (
        f"*🚨 New rug market — {symbol}*\n"
        f"`{_fmt_mint(m.get('mint'))}` · {chain}\n"
        f"\n"
        f"Will it drop >50% in 7 days?\n"
        f"Swarm prob: *{prob_pct:.1f}%*\n"
        f"{agent_line}\n"
        f"Pool: ${pool:,.0f} USDC · ttl {_ttl(m.get('expiry'))}\n"
        f"market #{m.get('market_id')}"
    )


# ----------------------------------------------------------------------
#  Command handlers
# ----------------------------------------------------------------------
WELCOME = (
    "*Rugged — the rugpull oracle bot.*\n"
    "\n"
    "I push alerts the moment our 3-agent swarm opens a new on-chain rug "
    "market on Arc, and let you bet with one tap (gas-free via Circle "
    "paymaster, no seed phrase).\n"
    "\n"
    "Commands:\n"
    "  /markets — top open markets right now\n"
    "  /mybets — your demo wallet's position\n"
    "  /bond — RugCheck reputation bond status\n"
    "  /stop — pause new-market alerts\n"
)


async def cmd_start(update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    fresh = add_subscriber(chat_id)
    suffix = "\n_(Subscribed — alerts on.)_" if fresh else "\n_(Already subscribed.)_"
    await update.message.reply_text(WELCOME + suffix, parse_mode=ParseMode.MARKDOWN)


async def cmd_stop(update: Update, _: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    removed = remove_subscriber(chat_id)
    msg = (
        "Alerts off — message /start to resubscribe."
        if removed
        else "You weren't subscribed."
    )
    await update.message.reply_text(msg)


async def _placeholder(update: Update, ctx: ContextTypes.DEFAULT_TYPE, text: str):
    """Send an instant ack + typing indicator while a slow API call runs.

    Returns the placeholder Message so the caller can `.edit_text(...)`
    once real data is available. This decouples user-visible latency
    from the cold-cache /api/markets enrichment time (~16s).
    """
    try:
        await ctx.bot.send_chat_action(
            chat_id=update.effective_chat.id, action=ChatAction.TYPING,
        )
    except Exception:  # noqa: BLE001 — typing is decorative
        pass
    return await update.message.reply_text(text)


async def cmd_markets(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    msg = await _placeholder(update, ctx, "🔍 Pulling live markets from Arc…")
    try:
        markets = await api.markets()
    except Exception as exc:  # noqa: BLE001
        await msg.edit_text(f"⚠️ API unreachable: {type(exc).__name__}: {exc}")
        return

    open_markets = [m for m in markets if not m.get("resolved")]
    if not open_markets:
        await msg.edit_text("No open markets right now — the swarm is quiet.")
        return

    # Sort by seed probability — hottest first; cap at 5.
    open_markets.sort(key=lambda m: m.get("seed_probability_bps") or 0, reverse=True)
    lines = ["*Top open markets*"]
    for m in open_markets[:5]:
        symbol = m.get("symbol", "RUGGED")
        prob = (m.get("seed_probability_bps") or 0) / 100
        pool = (m.get("yes_pool", 0) + m.get("no_pool", 0)) / 1_000_000
        lines.append(
            f"• *{symbol}* — {prob:.0f}% rug · ${pool:,.0f} pool · "
            f"ttl {_ttl(m.get('expiry'))}\n"
            f"  [open]({_market_link(m.get('market_id', 0), symbol)})"
        )
    await msg.edit_text(
        "\n".join(lines),
        parse_mode=ParseMode.MARKDOWN,
        disable_web_page_preview=True,
    )


async def cmd_mybets(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    # Wallets are per-user in the web app (Privy email/Google login → smart
    # account). The Telegram bot has no link to a user's web session, so we
    # deep-link them to the My Bets tab in the wallet modal.
    await update.message.reply_text(
        "*Your bets live in the web app*\n\n"
        "Open Rugged and sign in with the same email each time — your "
        "smart-account follows you across browsers.\n\n"
        f"{WEB_BASE}\n"
        "Then: click the wallet pill → *My bets* tab.",
        parse_mode=ParseMode.MARKDOWN,
        disable_web_page_preview=True,
    )


async def cmd_bond(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    msg = await _placeholder(update, ctx, "🔍 Checking RugCheck bond status…")
    try:
        stats = await api.stats()
    except Exception as exc:  # noqa: BLE001
        await msg.edit_text(f"⚠️ API unreachable: {type(exc).__name__}: {exc}")
        return

    hit_rate_pct = stats.get("hit_rate_pct")
    if hit_rate_pct is None:
        rate = stats.get("hit_rate") or 0
        hit_rate_pct = round(rate * 100, 1)
    resolved = stats.get("resolved_markets", 0)
    slash_threshold = 70.0
    status = "✅ HEALTHY" if hit_rate_pct >= slash_threshold else "⚠️ SLASHING"
    margin = hit_rate_pct - slash_threshold
    await msg.edit_text(
        "*RugCheck reputation bond*\n"
        f"Hit rate (30d rolling): *{hit_rate_pct:.1f}%* over {resolved} resolved markets\n"
        f"Slash threshold: {slash_threshold:.0f}%\n"
        f"Status: {status} ({margin:+.1f}% margin)\n"
        "\n"
        "Bonds slash when hit rate dips below threshold; slashed USDC "
        "redistributes to remaining bondholders.",
        parse_mode=ParseMode.MARKDOWN,
    )


# ----------------------------------------------------------------------
#  Background alert loop
# ----------------------------------------------------------------------
async def _alert_loop(application: Application) -> None:
    """Polls the API for new market ids and pushes alerts to subscribers."""
    log.info("alert loop · interval=%ds · API=%s", POLL_SECONDS, API_BASE)
    alerted = _alerted_ids()
    # On first start, seed `alerted` with the current set so we don't blast
    # the channel with a backlog of every existing market.
    seeded = False

    while True:
        try:
            markets = await api.markets()
        except Exception as exc:  # noqa: BLE001
            log.warning("alert poll: API unreachable — %s: %s", type(exc).__name__, exc)
            await asyncio.sleep(POLL_SECONDS)
            continue

        live = [
            m for m in markets
            if not m.get("historical") and not m.get("resolved")
        ]
        ids = {int(m["market_id"]) for m in live if "market_id" in m}

        if not seeded:
            # First successful poll — adopt the current set as baseline.
            new_ids: set[int] = set()
            if not alerted:
                alerted = ids.copy()
                _save_alerted(alerted)
            seeded = True
        else:
            new_ids = ids - alerted

        if new_ids:
            new_markets = [m for m in live if int(m.get("market_id", -1)) in new_ids]
            await _broadcast_new_markets(application, new_markets)
            alerted |= new_ids
            _save_alerted(alerted)

        await asyncio.sleep(POLL_SECONDS)


async def _broadcast_new_markets(
    application: Application, markets: list[dict[str, Any]],
) -> None:
    subs = _subscribers()
    if not subs:
        log.info("new market(s) but no subscribers — skipping push")
        return

    for m in markets:
        text = _market_card(m)
        keyboard = _market_keyboard(m.get("market_id", 0), m.get("symbol", "rug"))
        for chat_id in list(subs):
            try:
                await application.bot.send_message(
                    chat_id=chat_id,
                    text=text,
                    reply_markup=keyboard,
                    parse_mode=ParseMode.MARKDOWN,
                    disable_web_page_preview=True,
                )
            except Exception as exc:  # noqa: BLE001 — bad chat shouldn't kill the loop
                log.warning("push to %s failed: %s — dropping subscriber", chat_id, exc)
                remove_subscriber(chat_id)


# ----------------------------------------------------------------------
#  Application bootstrap
# ----------------------------------------------------------------------
def build_application(token: str) -> Application:
    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("stop", cmd_stop))
    app.add_handler(CommandHandler("markets", cmd_markets))
    app.add_handler(CommandHandler("mybets", cmd_mybets))
    app.add_handler(CommandHandler("bond", cmd_bond))

    async def _post_init(application: Application) -> None:
        application.create_task(_alert_loop(application))

    app.post_init = _post_init
    return app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Rugged Telegram alert bot")
    parser.add_argument("--dry-run", action="store_true",
                        help="exit immediately after building the application "
                             "(used for smoke tests)")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        log.error(
            "TELEGRAM_BOT_TOKEN is not set. Get one from @BotFather and "
            "add it to .env, then re-run."
        )
        return 2

    if args.dry_run:
        log.info("dry-run · token loaded · API=%s · web=%s", API_BASE, WEB_BASE)
        build_application(token)
        return 0

    application = build_application(token)
    log.info("rugged-bot ready · poll=%ds · API=%s", POLL_SECONDS, API_BASE)
    application.run_polling(allowed_updates=Update.ALL_TYPES)
    return 0


if __name__ == "__main__":
    sys.exit(main())
