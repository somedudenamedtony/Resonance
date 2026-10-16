import { impedance, returnLoss, swr, Z0 } from "./rf";
import type { Sweep } from "./sweep";

const num = (x: number, digits = 6) => (Number.isFinite(x) ? x.toFixed(digits) : "inf");

/** Touchstone v1 one-port file (.s1p): frequency in Hz, S11 as real/imaginary. */
export function toTouchstone(sweep: Sweep, comment = "Resonance export", z0 = Z0): string {
  const lines = [`! ${comment}`, `! ${new Date().toISOString()}`, `# HZ S RI R ${z0}`];
  sweep.freqHz.forEach((f, i) => {
    const g = sweep.s11[i]!;
    lines.push(`${Math.round(f)} ${g.re.toExponential(9)} ${g.im.toExponential(9)}`);
  });
  return lines.join("\n") + "\n";
}

/** CSV with the values people usually want next to the raw data. */
export function toCsv(sweep: Sweep, z0 = Z0): string {
  const lines = ["frequency_hz,s11_re,s11_im,swr,r_ohm,x_ohm,return_loss_db"];
  sweep.freqHz.forEach((f, i) => {
    const g = sweep.s11[i]!;
    const z = impedance(g, z0);
    lines.push([Math.round(f), num(g.re, 9), num(g.im, 9), num(swr(g), 4), num(z.re, 3), num(z.im, 3), num(returnLoss(g), 3)].join(","));
  });
  return lines.join("\n") + "\n";
}

/** Parse a Touchstone .s1p (RI, MA or DB formats; Hz/kHz/MHz/GHz). For test fixtures and import. */
export function parseTouchstone(text: string): Sweep {
  let unit = 1e9;
  let format = "MA";
  const freqHz: number[] = [];
  const s11: { re: number; im: number }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/!.*/, "").trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const t = line.slice(1).trim().toUpperCase().split(/\s+/);
      for (const tok of t) {
        if (tok === "HZ") unit = 1;
        else if (tok === "KHZ") unit = 1e3;
        else if (tok === "MHZ") unit = 1e6;
        else if (tok === "GHZ") unit = 1e9;
        else if (tok === "RI" || tok === "MA" || tok === "DB") format = tok;
      }
      continue;
    }
    const [f, a, b] = line.split(/\s+/).map(Number);
    if (f === undefined || a === undefined || b === undefined || [f, a, b].some((x) => !Number.isFinite(x))) {
      throw new Error(`bad Touchstone line: ${raw}`);
    }
    freqHz.push(f * unit);
    if (format === "RI") s11.push({ re: a, im: b });
    else {
      const mag = format === "DB" ? 10 ** (a / 20) : a;
      const ph = (b * Math.PI) / 180;
      s11.push({ re: mag * Math.cos(ph), im: mag * Math.sin(ph) });
    }
  }
  return { freqHz, s11 };
}
