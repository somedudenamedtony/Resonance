// Small stroke icons, drawn on a 24px grid. They inherit color from the surrounding text.

const PATHS = {
  antenna: "M12 21V9 M8.5 6.5a5 5 0 0 1 7 0 M5.5 3.5a9.2 9.2 0 0 1 13 0 M12 9 7 21 M12 9l5 12 M9 16h6",
  tune: "M4 20 20 4 M15 4h5v5 M9 15l-2-2 M12 12l-2-2 M6 18l-2-2",
  meter: "M3.5 17a8.5 8.5 0 0 1 17 0 M12 17l4.5-5.5 M6 11l1.4 1.4 M12 8.5V10.5 M18 11l-1.4 1.4",
  calibrate: "M4 7h10 M18 7h2 M4 17h2 M10 17h10 M16 5v4 M8 15v4",
  coax: "M3 12h4 M17 12h4 M7 8h10v8H7z M10 8v8 M14 8v8",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5 M12 7v5l3 2",
  home: "M4 11 12 4l8 7 M6 9.5V20h12V9.5 M10 20v-5h4v5",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z",
  chevron: "M9 6l6 6-6 6",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg
      class="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** The app mark: an SWR dip, the thing every check is looking for. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg class="logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="var(--trace)" />
      <path
        d="M10 20c8 0 11 26 22 26s14-26 22-26"
        fill="none"
        stroke="var(--on-trace)"
        stroke-width="5"
        stroke-linecap="round"
      />
      <circle cx="32" cy="46" r="4.5" fill="var(--on-trace)" />
    </svg>
  );
}
