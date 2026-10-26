/**
 * Emulated NanoVNA USB shell, modeled on NanoVNA-D (DiSlord) main.c:
 *   - characters are echoed as typed; '\r' ends the line and prints "\r\n"
 *   - the command runs, printing lines ending "\r\n"
 *   - the prompt "ch> " follows
 *   - `scan start stop [points] [outmask]` with outmask bits 0x01 freq, 0x02 S11, 0x04 S21,
 *     0x08 no calibration, 0x10 no e-delay, 0x20 no S21 offset, 0x80 binary
 *   - binary output: u16 mask, u16 points, then per point u32 freq, f32 re/im pairs
 *   - unknown commands print "<cmd>?"
 *
 * The "classic" dialect stands in for older firmware: 101 points, no binary output.
 */
import {
  coaxGamma,
  type CoaxModel,
  type Complex,
  distort,
  type ErrorTerms,
  fakeNanoVnaScreen,
  findPreset,
  rlcGamma,
  type RlcAntenna,
  seededRandom,
  typicalNanoVnaErrorTerms,
} from "@resonance/analysis";

export type Dialect = "nanovna-d" | "classic";

/** What is plugged into port 1. */
export type Port1 =
  | { kind: "antenna"; antenna: RlcAntenna }
  | { kind: "open" }
  | { kind: "short" }
  | { kind: "load" }
  | { kind: "coax"; model: CoaxModel };

export interface NanoVnaOptions {
  dialect: Dialect;
  /** Max points per scan. Defaults: 401 for nanovna-d, 101 for classic. */
  maxPoints?: number;
  port1: Port1;
  /** Error terms of the uncalibrated port (what raw data looks like). */
  errorTerms: (fHz: number) => ErrorTerms;
  /** Std-dev of complex noise on each reading. */
  noise: number;
  /** Simulated sweep time per point, ms. 0 answers immediately. */
  msPerPoint: number;
  /** When true, the device ignores input (hung). */
  hung: boolean;
}

export const DEFAULT_OPTIONS: NanoVnaOptions = {
  dialect: "nanovna-d",
  port1: { kind: "antenna", antenna: findPreset("good20")!.antenna },
  errorTerms: typicalNanoVnaErrorTerms,
  noise: 0.001,
  msPerPoint: 0.5,
  hung: false,
};

const MASK = { FREQ: 0x01, S11: 0x02, S21: 0x04, NO_CAL: 0x08, BINARY: 0x80 } as const;
const PROMPT = "ch> ";
const NL = "\r\n";

const enc = new TextEncoder();

/** NanoVNA-D my_atoui: decimal, or 0x / 0o / 0b prefixed; stops at the first bad digit. */
export function myAtoui(s: string): number {
  let p = 0;
  let radix = 10;
  if (s[p] === "+") p++;
  if (s[p] === "0" && s[p + 1] !== undefined) {
    const r = { x: 16, o: 8, b: 2 }[s[p + 1]!.toLowerCase() as "x" | "o" | "b"];
    if (r) {
      radix = r;
      p += 2;
    }
  }
  let v = 0;
  for (; p < s.length; p++) {
    const d = parseInt(s[p]!, radix);
    if (Number.isNaN(d)) break;
    v = (v * radix + d) >>> 0;
  }
  return v;
}

/** C printf("%f") */
const f6 = (x: number) => x.toFixed(6);

export class NanoVnaEmulator {
  options: NanoVnaOptions;
  /** Bytes the device sends to the host. */
  onOutput: (bytes: Uint8Array) => void = () => {};

  private line = "";
  private pending: string[] = [];
  private running = false;
  private rand = seededRandom(1234);
  private sweep = { start: 50_000, stop: 900_000_000, points: 101 };
  private lastSweep: { freq: number[]; s11: Complex[] } = { freq: [], s11: [] };
  /** Every command line executed, for tests. */
  readonly history: string[] = [];

  constructor(options: Partial<NanoVnaOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get maxPoints(): number {
    return this.options.maxPoints ?? (this.options.dialect === "nanovna-d" ? 401 : 101);
  }

  /** USB connected: the shell prints its banner and first prompt. */
  attach(): void {
    this.line = "";
    this.pending = [];
    this.write(NL + "NanoVNA Shell" + NL + PROMPT);
  }

  /** Bytes from the host. */
  input(data: Uint8Array): void {
    if (this.options.hung) return;
    for (const b of data) {
      if (b === 0x0d) {
        this.write(NL);
        this.pending.push(this.line);
        this.line = "";
      } else if (b === 0x08 || b === 0x7f) {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.write("\x08 \x08");
        }
      } else if (b >= 0x20 && this.line.length < 63) {
        this.line += String.fromCharCode(b);
        this.write(new Uint8Array([b])); // echo
      }
    }
    void this.runPending();
  }

  private async runPending(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const cmdLine = this.pending.shift()!;
        await this.execute(cmdLine);
        this.write(PROMPT);
      }
    } finally {
      this.running = false;
    }
  }

  private write(data: string | Uint8Array): void {
    this.onOutput(typeof data === "string" ? enc.encode(data) : data);
  }

  private async execute(cmdLine: string): Promise<void> {
    const argv = cmdLine.split(" ").filter((s) => s.length > 0);
    if (argv.length === 0) return;
    this.history.push(cmdLine);
    const [cmd, ...args] = argv as [string, ...string[]];
    if (args.length > 4) {
      this.write(`too many arguments, max 4${NL}`);
      return;
    }
    switch (cmd) {
      case "version":
        this.write(`${this.options.dialect === "nanovna-d" ? "1.2.40-emu" : "0.8.4-emu"}${NL}`);
        return;
      case "info":
        this.write(this.infoText());
        return;
      case "help":
        this.write(`Commands: ${this.commandList().join(" ")}${NL}`);
        return;
      case "scan":
        await this.scan(args, false);
        return;
      case "scan_bin":
        if (this.options.dialect !== "nanovna-d") break;
        await this.scan(args, true);
        return;
      case "pause":
      case "resume":
      case "trace":
      case "marker":
        return;
      case "sweep":
        if (args.length === 0) this.write(`${this.sweep.start} ${this.sweep.stop} ${this.sweep.points}${NL}`);
        else {
          this.sweep.start = myAtoui(args[0]!);
          if (args[1]) this.sweep.stop = myAtoui(args[1]);
          if (args[2]) this.sweep.points = myAtoui(args[2]);
        }
        return;
      case "data": {
        const ch = args.length ? myAtoui(args[0]!) : 0;
        if (ch === 0) for (const g of this.lastSweep.s11) this.write(`${f6(g.re)} ${f6(g.im)}${NL}`);
        return;
      }
      case "capture": {
        const [w, h] = this.options.dialect === "nanovna-d" ? [480, 320] : [320, 240];
        this.write(fakeNanoVnaScreen(w, h, this.lastSweep.s11));
        return;
      }
      case "cal":
        this.write(`complete: open short load thru isoln${NL}`);
        return;
    }
    this.write(`${cmd}?${NL}`);
  }

  private commandList(): string[] {
    const common = ["scan", "data", "sweep", "pause", "resume", "trace", "marker", "cal", "capture", "version", "info", "help"];
    return this.options.dialect === "nanovna-d" ? [...common, "scan_bin"] : common;
  }

  private infoText(): string {
    if (this.options.dialect === "classic") {
      return ["Kernel: 4.0.0", "Compiler: GCC 7.2.1", "Board: NanoVNA", "Version: 0.8.4-emu"].join(NL) + NL;
    }
    return (
      [
        "Board: NanoVNA-H 4",
        "2019-2024 Copyright @DiSlord (based on @edy555 source)",
        "Licensed under GPL.",
        "  https://github.com/DiSlord/NanoVNA-D",
        `Version: 1.2.40-emu [p:${this.maxPoints}, IF:12k, ADC:384k, Lcd:480x320]`,
        "Build Time: Oct 16 2026 - 12:00:00",
      ].join(NL) + NL
    );
  }

  /** Γ that port 1 really presents at f. */
  private actualGamma(fHz: number): Complex {
    const p = this.options.port1;
    switch (p.kind) {
      case "antenna":
        return rlcGamma(p.antenna, fHz);
      case "open":
        return { re: 1, im: 0 };
      case "short":
        return { re: -1, im: 0 };
      case "load":
        return { re: 0, im: 0 };
      case "coax":
        return coaxGamma(p.model, fHz);
    }
  }

  private gauss(): number {
    const u = Math.max(1e-12, this.rand());
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  private async scan(args: string[], scanBin: boolean): Promise<void> {
    if (args.length < 2 || args.length > 4) {
      this.write(`usage: scan {start(Hz)} {stop(Hz)} [points] [outmask]${NL}`);
      return;
    }
    const start = myAtoui(args[0]!);
    const stop = myAtoui(args[1]!);
    if (start === 0 || stop === 0 || start > stop) {
      this.write(`frequency range is invalid${NL}`);
      return;
    }
    let points = this.sweep.points;
    if (args.length >= 3) {
      points = myAtoui(args[2]!);
      if (points === 0 || points > this.maxPoints) {
        this.write(`sweep points exceeds range ${this.maxPoints}${NL}`);
        return;
      }
    }
    let mask = args.length === 4 ? myAtoui(args[3]!) & 0xffff : 0;
    if (scanBin && args.length === 4) mask |= MASK.BINARY;
    if (this.options.dialect !== "nanovna-d") mask &= ~MASK.BINARY;
    this.sweep = { start, stop, points };

    const freq: number[] = [];
    const s11: Complex[] = [];
    const s21: Complex[] = [];
    const n = this.options.noise;
    for (let i = 0; i < points; i++) {
      const f = points > 1 ? start + Math.floor(((stop - start) * i) / (points - 1)) : start;
      const actual = this.actualGamma(f);
      // Device calibration is applied unless the mask says not to; model it as perfect.
      const g = mask & MASK.NO_CAL ? distort(actual, this.options.errorTerms(f)) : actual;
      freq.push(f);
      s11.push({ re: g.re + this.gauss() * n, im: g.im + this.gauss() * n });
      s21.push({ re: this.gauss() * 0.002, im: this.gauss() * 0.002 }); // nothing on port 2
    }
    this.lastSweep = { freq, s11 };

    if (this.options.msPerPoint > 0) {
      await new Promise((r) => setTimeout(r, this.options.msPerPoint * points));
    }
    if (!mask) return;

    if (mask & MASK.BINARY) {
      const rec = (mask & MASK.FREQ ? 4 : 0) + (mask & MASK.S11 ? 8 : 0) + (mask & MASK.S21 ? 8 : 0);
      const buf = new ArrayBuffer(4 + points * rec);
      const dv = new DataView(buf);
      dv.setUint16(0, mask, true);
      dv.setUint16(2, points, true);
      let o = 4;
      for (let i = 0; i < points; i++) {
        if (mask & MASK.FREQ) {
          dv.setUint32(o, freq[i]!, true);
          o += 4;
        }
        if (mask & MASK.S11) {
          dv.setFloat32(o, s11[i]!.re, true);
          dv.setFloat32(o + 4, s11[i]!.im, true);
          o += 8;
        }
        if (mask & MASK.S21) {
          dv.setFloat32(o, s21[i]!.re, true);
          dv.setFloat32(o + 4, s21[i]!.im, true);
          o += 8;
        }
      }
      this.write(new Uint8Array(buf));
      return;
    }
    let out = "";
    for (let i = 0; i < points; i++) {
      if (mask & MASK.FREQ) out += `${freq[i]} `;
      if (mask & MASK.S11) out += `${f6(s11[i]!.re)} ${f6(s11[i]!.im)} `;
      if (mask & MASK.S21) out += `${f6(s21[i]!.re)} ${f6(s21[i]!.im)} `;
      out += NL;
    }
    this.write(out);
  }
}
