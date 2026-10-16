// Configure and build firmware/host (the C bridge core + resonance-bridge-host + core_tests).
// Usage: node scripts/build-host.mjs [--release]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const src = resolve(root, "firmware/host");
const release = process.argv.includes("--release");
const build = resolve(root, release ? "firmware/build-host-release" : "firmware/build-host");

const hasNinja = spawnSync("ninja", ["--version"], { stdio: "ignore" }).status === 0;
if (!existsSync(resolve(build, "CMakeCache.txt"))) {
  const args = ["-S", src, "-B", build, `-DCMAKE_BUILD_TYPE=${release ? "Release" : "Debug"}`];
  if (hasNinja) args.push("-G", "Ninja");
  execFileSync("cmake", args, { stdio: "inherit" });
}
execFileSync("cmake", ["--build", build], { stdio: "inherit" });
console.log(`bridge host built in ${build}`);
