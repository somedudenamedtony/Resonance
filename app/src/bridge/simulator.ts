import {
  ANTENNA_PRESETS,
  type AntennaPreset,
  distort,
  type ErrorTerms,
  IDENTITY_TERMS,
  type AntennaType,
  coaxGamma,
  type CoaxModel,
  type Complex,
  fakeNanoVnaScreen,
  estimateElementLengthM,
  type RlcAntenna,
  rlcGamma,
  seededRandom,
} from "@resonance/analysis";
import {
  type ClientMessage,
  encodeCaptureFrame,
  encodeScanFrame,
  PROTOCOL_VERSION,
  recordsPerFrame,
  type ScanPoint,
  type ServerMessage,
} from "./protocol";
import type { Transport } from "./transport";

/** Antennas the simulator can pretend to be measuring (shared with the emulator). */
export const SIM_ANTENNAS: readonly AntennaPreset[] = ANTENNA_PRESETS;

export interface SimulatorOptions {
  /** Preset id from SIM_ANTENNAS. */
  antennaId: string;
  /** Error terms applied to the "raw" output, as a real uncalibrated NanoVNA would. */
  errorTerms: (fHz: number) => ErrorTerms;
  /** Std-dev of complex noise added to each reading. */
  noise: number;
  /** Milliseconds per 100 points, to make scans feel real. */
  msPer100Points: number;
  /** When false, the simulated NanoVNA is unplugged. */
  deviceConnected: boolean;
  /** A calibration standard on port 1 instead of the antenna. */
  standard: "open" | "short" | "load" | null;
  /** Use this antenna instead of the preset (set by trim()). */
  antenna: RlcAntenna | null;
  /** A coax cable on port 1 (for the coax test) instead of the antenna. */
  coax: CoaxModel | null;
}

export const DEFAULT_SIM_OPTIONS: SimulatorOptions = {
  antennaId: "good20",
  errorTerms: () => IDENTITY_TERMS,
  noise: 0.002,
  msPer100Points: 180,
  deviceConnected: true,
  standard: null,
  antenna: null,
  coax: null,
};

/**
 * An in-browser stand-in for the ESP32 bridge plus a NanoVNA. It speaks the same protocol,
 * including binary scan frames, so the app's bridge client is exercised end to end.
 */
export class SimulatedTransport implements Transport {
  readonly kind = "simulator" as const;
  readonly label = "Simulator";
  onOpen?: () => void;
  onClose?: () => void;
  onText?: (text: string) => void;
  onBinary?: (buf: ArrayBuffer) => void;

  private open = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private activeScan: number | null = null;
  private rand = seededRandom(7);
  private lastS11: Complex[] = [];

  constructor(public options: SimulatorOptions = { ...DEFAULT_SIM_OPTIONS }) {}

  connect(): void {
    this.open = true;
    this.later(30, () => this.onOpen?.());
  }

  close(): void {
    this.open = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.activeScan = null;
  }

  /** Change simulator settings; re-announces device state. */
  configure(patch: Partial<SimulatorOptions>): void {
    this.options = { ...this.options, ...patch };
    if (this.open) this.emit(this.deviceMessage());
  }

  /** The antenna currently on port 1. */
  get antenna(): RlcAntenna {
    return this.options.antenna ?? (SIM_ANTENNAS.find((a) => a.id === this.options.antennaId) ?? SIM_ANTENNAS[0]!).antenna;
  }

  /**
   * Physically trim the simulated antenna by `deltaM` meters per element (negative adds wire).
   * Resonance scales as 1/length, using the element length implied by the current resonance.
   */
  trim(deltaM: number, type: AntennaType): void {
    const a = this.antenna;
    const lengthM = estimateElementLengthM(type, a.f0Hz);
    this.configure({ antenna: { ...a, f0Hz: (a.f0Hz * lengthM) / (lengthM - deltaM) } });
  }

  send(msg: ClientMessage): void {
    if (!this.open) throw new Error("bridge is not connected");
    switch (msg.type) {
      case "hello":
        this.later(20, () => this.emit(this.deviceMessage()));
        break;
      case "scan":
        this.scan(msg.id, msg.startHz, msg.stopHz, msg.points);
        break;
      case "cancel":
        if (this.activeScan === msg.id) {
          this.activeScan = null;
          this.emit({ v: 1, type: "scan.end", id: msg.id, durationMs: 0, cancelled: true });
        }
        break;
      case "raw":
        this.later(40, () =>
          this.emit({ v: 1, type: "raw.reply", command: msg.command, text: this.rawReply(msg.command) }),
        );
        break;
      case "capture": {
        if (!this.options.deviceConnected) {
          this.emit({ v: 1, type: "error", code: "no_device", message: "NanoVNA not detected" });
          break;
        }
        const w = 480;
        const h = 320;
        const img = fakeNanoVnaScreen(w, h, this.lastS11);
        this.emit({ v: 1, type: "capture.begin", width: w, height: h, format: "rgb565be" });
        for (let o = 0; o < img.length; o += 4088) this.onBinary?.(encodeCaptureFrame(o, img.subarray(o, o + 4088)));
        this.later(30, () => this.emit({ v: 1, type: "capture.end", bytes: img.length }));
        break;
      }
      case "wifi.set":
      case "ota.begin":
        this.later(20, () => this.emit({ v: 1, type: "ok", for: msg.type }));
        break;
    }
  }

  private deviceMessage(): ServerMessage {
    return this.options.deviceConnected
      ? {
          v: PROTOCOL_VERSION,
          type: "device",
          connected: true,
          model: "NanoVNA-H4 (simulated)",
          firmware: "1.2.40-sim",
          maxPoints: 401,
          bridgeVersion: "0.1.0-sim",
        }
      : { v: PROTOCOL_VERSION, type: "device", connected: false, bridgeVersion: "0.1.0-sim" };
  }

  private rawReply(command: string): string {
    const cmd = command.trim().split(/\s+/)[0] ?? "";
    switch (cmd) {
      case "version":
        return "1.2.40-sim";
      case "info":
        return "Board: NanoVNA-H4 (simulated)\nResonance simulator";
      case "help":
        return "Commands: version info scan sweep data cal pause resume capture";
      default:
        return `${cmd}?`;
    }
  }

  private scan(id: number, startHz: number, stopHz: number, points: number): void {
    if (!this.options.deviceConnected) {
      this.emit({ v: 1, type: "error", code: "no_device", message: "NanoVNA not detected", id });
      return;
    }
    if (this.activeScan !== null) {
      this.emit({ v: 1, type: "error", code: "busy", message: "a scan is already running", id });
      return;
    }
    if (!(points >= 2 && points <= 10001 && stopHz > startHz && startHz > 0)) {
      this.emit({ v: 1, type: "error", code: "bad_request", message: "invalid scan parameters", id });
      return;
    }

    const antenna = this.antenna;
    const all: ScanPoint[] = [];
    const step = (stopHz - startHz) / (points - 1);
    for (let i = 0; i < points; i++) {
      const f = startHz + i * step;
      const std = this.options.standard;
      const actual = std === "open" ? { re: 1, im: 0 } : std === "short" ? { re: -1, im: 0 } : std === "load" ? { re: 0, im: 0 } : this.options.coax ? coaxGamma(this.options.coax, f) : rlcGamma(antenna, f);
      const g = distort(actual, this.options.errorTerms(f));
      const n = this.options.noise;
      all.push({ freqHz: f, s11re: g.re + this.gauss() * n, s11im: g.im + this.gauss() * n });
    }

    this.lastS11 = all.map((p) => ({ re: p.s11re, im: p.s11im }));
    this.activeScan = id;
    const started = performance.now();
    this.emit({ v: 1, type: "scan.begin", id, points, ports: "s11" });

    const chunk = Math.min(recordsPerFrame(false), 50); // small chunks so the curve draws progressively
    const delay = Math.max(10, (this.options.msPer100Points * chunk) / 100);
    let offset = 0;
    const sendNext = () => {
      if (this.activeScan !== id) return;
      const slice = all.slice(offset, offset + chunk);
      this.onBinary?.(encodeScanFrame({ scanId: id, offset, hasS21: false, points: slice }));
      offset += slice.length;
      if (offset < points) this.later(delay, sendNext);
      else {
        this.activeScan = null;
        this.emit({ v: 1, type: "scan.end", id, durationMs: Math.round(performance.now() - started) });
      }
    };
    this.later(delay, sendNext);
  }

  private gauss(): number {
    // Box–Muller with the seeded generator so scans are repeatable.
    const u = Math.max(1e-12, this.rand());
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  private emit(msg: ServerMessage): void {
    if (this.open) this.onText?.(JSON.stringify(msg));
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }
}
