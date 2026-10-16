import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Build the C bridge host once before the end-to-end tests.
export default function setup(): void {
  execFileSync("node", [resolve(__dirname, "../scripts/build-host.mjs")], { stdio: "inherit" });
}
