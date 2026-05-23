import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Rugged frontend dev/build config.
//
// Dev: `npm run dev` starts Vite on http://localhost:5173 with HMR.
//      /api/* is proxied to FastAPI at :8001 so wallet + market reads work
//      identically in dev and prod. Static traces under /traces/* also proxy.
//
// Build: `npm run build` emits ../web/dist which FastAPI mounts in production.
//        Hashed asset filenames + immutable caching.
//
// Why node polyfills: Privy's transitive dep tree (WalletConnect, secp256k1,
// etc.) calls Node-style APIs like Buffer and process. Without the polyfill,
// you get runtime warnings and some flows (notably signing) silently break.
export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      // Only polyfill what Privy actually needs — keeps the bundle small.
      include: ["buffer", "process", "util", "stream", "crypto"],
      globals: { Buffer: true, global: true, process: true },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:8001",
        changeOrigin: true,
      },
      "/traces": {
        target: "http://localhost:8001",
        changeOrigin: true,
      },
      // Arc Testnet's RPC doesn't send CORS headers, so the browser can't
      // hit it directly (viem.prepareUserOperation + smart-account address
      // derivation both need chain reads from the browser). Proxy it
      // through Vite — same-origin from the page's perspective. In prod
      // the FastAPI backend should serve the same path.
      "/arc-rpc": {
        target: "https://rpc.testnet.arc-node.thecanteenapp.com",
        changeOrigin: true,
        rewrite: (path) =>
          path.replace(
            /^\/arc-rpc/,
            "/v1/swrm_06df66a5232ce2959f69ccdb230322a14db7008372efac51e0c902dbb0ce7a3f",
          ),
        secure: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1500, // Privy + viem are bulky; ok for now
  },
  define: {
    // Privy's SDK reads NODE_ENV at runtime; vite injects it via this define.
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "development"),
  },
});
