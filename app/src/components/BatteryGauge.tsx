import { batteryPercent, LOW_BATTERY_PERCENT } from "../battery";

/** A small battery outline, filled to the charge level. Inherits the text color; red when low. */
export function BatteryGauge({ mV }: { mV: number }) {
  const pct = batteryPercent(mV);
  const low = pct <= LOW_BATTERY_PERCENT;
  const fill = Math.max(1.5, (pct / 100) * 15);
  return (
    <svg class={low ? "battery-gauge low" : "battery-gauge"} width="22" height="12" viewBox="0 0 22 12" aria-hidden="true">
      <rect x="0.75" y="0.75" width="18.5" height="10.5" rx="2.25" fill="none" stroke="currentColor" stroke-width="1.5" />
      <rect x="20.25" y="3.75" width="1.5" height="4.5" rx="0.75" fill="currentColor" />
      <rect x="2.5" y="2.5" width={fill} height="7" rx="1" fill="currentColor" />
    </svg>
  );
}
