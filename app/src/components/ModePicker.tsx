import { MODE_ORDER, type OperatingMode } from "@resonance/analysis";
import { settings, updateSettings } from "../state";

const LABELS: Record<OperatingMode, string> = { cw: "CW", digital: "FT8 / FT4", phone: "SSB" };

/**
 * Where you operate: whole band, or any mix of CW, digital and phone. Saved in settings, so
 * every check judges the part of the band you use.
 */
export function ModePicker({ onChange }: { onChange?: (modes: OperatingMode[]) => void }) {
  const s = settings.value;
  const modes = s.modes;
  const set = (next: OperatingMode[]) => {
    void updateSettings({ ...s, modes: next });
    onChange?.(next);
  };
  const toggle = (m: OperatingMode) =>
    set(modes.includes(m) ? modes.filter((x) => x !== m) : MODE_ORDER.filter((x) => x === m || modes.includes(x)));
  return (
    <div class="segmented" role="group" aria-label="Where you operate">
      <button aria-pressed={modes.length === 0} class={modes.length === 0 ? "on" : ""} onClick={() => set([])}>
        Whole band
      </button>
      {MODE_ORDER.map((m) => (
        <button key={m} aria-pressed={modes.includes(m)} class={modes.includes(m) ? "on" : ""} onClick={() => toggle(m)}>
          {LABELS[m]}
        </button>
      ))}
    </div>
  );
}
