/**
 * Start the emulated bridge for app development:
 *
 *   npm run emulate                        # NanoVNA-D emulator, well-tuned 20m dipole
 *   npm run emulate -- --antenna long20    # other presets: short40, mismatch20, efhw40
 *   npm run emulate -- --dialect classic   # older firmware: 101 points, text scans
 *   npm run emulate -- --raw               # realistic uncalibrated errors on raw data
 *
 * Then open the printed URL (serves app/dist), or run `npm run dev` and open
 * http://localhost:5173/?bridge=ws://127.0.0.1:8080/ws
 *
 * Type commands at the prompt: attach, detach, antenna <id>, port open|short|load|antenna, quit.
 */
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { ANTENNA_PRESETS, findPreset, IDENTITY_TERMS, typicalNanoVnaErrorTerms } from "@resonance/analysis";
import { EmulatedBridge, REPO_ROOT } from "./bridgeHost";
import type { Dialect } from "./nanovna";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const antennaId = arg("antenna", "good20")!;
const preset = findPreset(antennaId);
if (!preset) {
  console.error(`unknown antenna ${antennaId}. Presets: ${ANTENNA_PRESETS.map((p) => p.id).join(", ")}`);
  process.exit(1);
}
const dialect = (arg("dialect", "nanovna-d") as Dialect) ?? "nanovna-d";
const port = Number(arg("port", "8080"));
const raw = process.argv.includes("--raw");

const bridge = new EmulatedBridge({
  port,
  host: arg("host", "127.0.0.1"),
  serveDir: resolve(REPO_ROOT, "app/dist"),
  nanovna: {
    dialect,
    port1: { kind: "antenna", antenna: preset.antenna },
    errorTerms: raw ? typicalNanoVnaErrorTerms : () => IDENTITY_TERMS,
    msPerPoint: Number(arg("ms-per-point", "2")),
  },
  onLog: (l) => console.log(`[bridge] ${l}`),
});

await bridge.start();
console.log(`\nEmulated Resonance bridge (${dialect}, ${preset.name}${raw ? ", raw errors" : ""})`);
console.log(`  App:       ${bridge.origin}/?bridge=${bridge.url}`);
console.log(`  WebSocket: ${bridge.url}`);
console.log(`  Dev app:   http://localhost:5173/?bridge=${bridge.url}\n`);
console.log("Commands: attach | detach | antenna <id> | port open|short|load|antenna | quit\n");

let current = preset.antenna;
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "emu> " });
rl.prompt();
rl.on("line", async (line) => {
  const [cmd, a] = line.trim().split(/\s+/);
  switch (cmd) {
    case "attach":
      bridge.attach();
      break;
    case "detach":
      bridge.detach();
      break;
    case "antenna": {
      const p = a ? findPreset(a) : undefined;
      if (!p) console.log(`presets: ${ANTENNA_PRESETS.map((x) => x.id).join(", ")}`);
      else {
        current = p.antenna;
        bridge.nanovna.options.port1 = { kind: "antenna", antenna: current };
        console.log(`now measuring: ${p.name}`);
      }
      break;
    }
    case "port":
      if (a === "open" || a === "short" || a === "load") bridge.nanovna.options.port1 = { kind: a };
      else bridge.nanovna.options.port1 = { kind: "antenna", antenna: current };
      console.log(`port 1: ${a ?? "antenna"}`);
      break;
    case "quit":
    case "exit":
      await bridge.stop();
      process.exit(0);
    case "":
    case undefined:
      break;
    default:
      console.log("unknown command");
  }
  rl.prompt();
});
rl.on("close", async () => {
  await bridge.stop();
  process.exit(0);
});
