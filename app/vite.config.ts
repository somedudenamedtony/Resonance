import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [preact()],
  // Relative asset paths so the bundle works when served from the bridge's LittleFS root.
  base: "./",
  build: {
    target: "safari16",
    sourcemap: false,
    assetsInlineLimit: 0,
  },
});
