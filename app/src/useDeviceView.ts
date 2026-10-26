import { useEffect } from "preact/hooks";
import type { DisplayView } from "./bridge/protocol";
import { client, settings } from "./state";

/**
 * Ask for `view` on the NanoVNA while this screen shows it (null: nothing to show). Changes are
 * settled for a moment first so a dragged marker doesn't flood the bridge.
 */
export function useDeviceView(view: DisplayView | null): void {
  const key = settings.value.mirrorScreen && view ? JSON.stringify(view) : null;
  useEffect(() => {
    const t = setTimeout(() => client.display(key ? (JSON.parse(key) as DisplayView) : null), 150);
    return () => clearTimeout(t);
  }, [key]);
}

/** Screens that set the device's view themselves; everywhere else the device is let go. */
export const MIRRORED_ROUTES: ReadonlySet<string> = new Set(["check", "advanced", "tune", "meter"]);
