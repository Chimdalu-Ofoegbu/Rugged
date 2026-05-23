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
// because Arc (5042002) isn't on its supported-chains list. There's no
// official way to keep the SDK out of the bundle without forking Privy, and
// the message is purely informational — we never expose Coinbase Smart
// Wallet to users (loginMethods is just email + google). Filter it before
// it ever reaches the console.
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
          // Only embedded-wallet flows. Excluding "wallet" from
          // loginMethods skips the external wallet connectors entirely,
          // which silences the "configured chains are not supported by
          // Coinbase Smart Wallet" startup warnings — Arc isn't in
          // Coinbase Smart Wallet's chain list and we don't need it.
          // Only embedded-wallet flows. "wallet" is intentionally absent —
          // Privy still ships Coinbase SDK in the bundle (and its init logs
          // are filtered at the top of this file), but no UI affordance lets
          // a user pick it.
          loginMethods: ["email", "google"],
          appearance: {
            theme: "dark",
            accentColor: "#ee5a3a",
            showWalletLoginFirst: false,
          },
          embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
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
