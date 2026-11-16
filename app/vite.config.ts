import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

/** The release version, from the firmware header, so the app knows which release it belongs to. */
function releaseVersion(): string {
  const header = fileURLToPath(new URL("../firmware/components/resonance_core/include/rc_bridge.h", import.meta.url));
  const m = /#define\s+RC_BRIDGE_VERSION\s+"([^"]+)"/.exec(readFileSync(header, "utf8"));
  if (!m) throw new Error("RC_BRIDGE_VERSION not found in rc_bridge.h");
  return m[1]!;
}

export default defineConfig({
  plugins: [preact()],
  define: { __APP_VERSION__: JSON.stringify(releaseVersion()) },
  // Relative asset paths so the bundle works when served from the bridge's LittleFS root.
  base: "./",
  build: {
    target: "safari16",
    sourcemap: false,
    assetsInlineLimit: 0,
  },
});
