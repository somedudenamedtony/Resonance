/**
 * The release this copy of the app was built for: RC_BRIDGE_VERSION from the firmware header,
 * baked in at build time (vite.config.ts). The firmware and the app ship together in one
 * release, so this says which release's app is on the bridge, independent of its firmware.
 */
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
