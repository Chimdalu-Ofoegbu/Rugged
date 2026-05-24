// Rugged · React entry point.
//
// Boot order:
//   1. Fetch live contract addresses from /api/paymaster/info so the
//      frontend doesn't drift from the backend's .env (no rebuild needed
//      after a redeploy — just hard-reload the page).
//   2. Mount React inside PrivyProvider (if VITE_PRIVY_APP_ID is set).
//
// The prototype JSX files attach components to `window` during module init
// (see Object.assign(window, …) at the bottom of markets.jsx and bond.jsx),
// so import order matters: markets + bond must run BEFORE app reads them
// off window.

import ReactDOM from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";

// Suppress the Coinbase Smart Wallet "configured chains are not supported"
// console.info. Privy auto-loads @coinbase/wallet-sdk because it's part of
// their default connector bundle; the SDK then logs that warning at init
// because Arc (5042002) isn't on its supported-chains list. The Smart Wallet
// connector itself is disabled via externalWallets.coinbaseWallet =
// { connectionOptions: "eoaOnly" } below (users picking "Coinbase Wallet"
// from the wallet picker get the EOA extension/mobile flow, which DOES
// support arbitrary chains). The startup log fires before that config is
// consulted, so we still filter it here.
const _origInfo = console.info;
console.info = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === "string" && first.includes("not supported by Coinbase Smart Wallet")) {
    return;
  }
  _origInfo.apply(console, args as never);
};

import "./styles/styles.css";
import "./styles/detail.css";
import "./styles/bond.css";

import { arcTestnet } from "./arc-chain";
import { PRIVY_APP_ID, bootstrapContracts } from "./config";

// Side-effect imports: each prototype file attaches components to window.
// markets.jsx must run first because app.jsx reads MarketsPage/MarketDetail
// and bond.jsx-defined BondPage off window during render.
import "./prototype/markets.jsx";
import "./prototype/bond.jsx";
import App from "./prototype/app.jsx";

async function boot() {
  // Sync contract addresses with the backend before any component reads
  // them. Resolves regardless of success — failures fall back to the
  // compile-time VITE_* seeds.
  await bootstrapContracts();

  const root = ReactDOM.createRoot(document.getElementById("root")!);

  if (PRIVY_APP_ID) {
    root.render(
      <PrivyProvider
        appId={PRIVY_APP_ID}
        config={{
          // Two paths into Rugged:
          //   - "email": magic-link sign-in → Privy provisions an embedded
          //     wallet (MPC, no seed phrase). Used as the smart-account owner.
          //   - "wallet": connect an external EOA (MetaMask, Rabby, Coinbase
          //     Wallet extension, WalletConnect). That EOA becomes the
          //     smart-account owner directly; no embedded wallet is created.
          loginMethods: ["email", "wallet"],
          appearance: {
            theme: "dark",
            // Slightly muted ember. Our app uses the brighter #ee5a3a for
            // its own primary CTAs, but Privy applies accentColor to ALL of
            // its hosted-modal buttons (login, connect, export-key) which
            // makes the bright value read as "danger" rather than "primary"
            // — especially loud on the full-width "Copy key" button in the
            // export modal. The muted variant stays on-brand without
            // overwhelming the iframe.
            accentColor: "#c95637",
            // Email is the headline primary CTA; wallet sits underneath.
            showWalletLoginFirst: false,
          },
          // Force Coinbase Wallet to "EOA only" so the picker offers the
          // extension/mobile app (Arc-compatible) and skips Coinbase Smart
          // Wallet (which hard-codes its own supported-chains list and would
          // fail on Arc).
          externalWallets: {
            coinbaseWallet: { connectionOptions: "eoaOnly" },
          },
          // Only provision an embedded wallet for users who didn't bring
          // their own. External-wallet users use their connected EOA as
          // the smart-account owner — no second wallet needed.
          embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
          defaultChain: arcTestnet,
          supportedChains: [arcTestnet],
        }}
      >
        <App />
      </PrivyProvider>,
    );
  } else {
    // No Privy app id — render the app, but login attempts will throw.
    root.render(<App />);
  }
}

boot();
