import { distort, type ErrorTerms, IDENTITY_TERMS, type RlcAntenna, rlcGamma, seededRandom } from "@resonance/analysis";
import {
  type ClientMessage,
  encodeScanFrame,
  PROTOCOL_VERSION,
  recordsPerFrame,
  type ScanPoint,
  type ServerMessage,
} from "./protocol";
import type { Transport } from "./transport";

export interface SimAntennaPreset {
  id: string;
  name: string;
  antenna: RlcAntenna;
}

/** Antennas the simulator can pretend to be measuring. */
export const SIM_ANTENNAS: readonly SimAntennaPreset[] = [
  { id: "good20", name: "20m dipole, well tuned", antenna: { f0Hz: 14.175e6, r: 52, q: 3.5 } },
  { id: "long20", name: "20m dipole, too long", antenna: { f0Hz: 13.82e6, r: 60, q: 7 } },
  { id: "short40", name: "40m dipole, too short", antenna: { f0Hz: 7.42e6, r: 58, q: 6 } },
  { id: "mismatch20", name: "20m vertical, poor match", antenna: { f0Hz: 14.2e6, r: 16, q: 5 } },
  { id: "efhw40", name: "40m EFHW, usable", antenna: { f0Hz: 7.12e6, r: 50, q: 12 } },
];

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
}

export const DEFAULT_SIM_OPTIONS: SimulatorOptions = {
  antennaId: "good20",
  errorTerms: () => IDENTITY_TERMS,
  noise: 0.002,
  msPer100Points: 180,
  deviceConnected: true,
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

    const preset = SIM_ANTENNAS.find((a) => a.id === this.options.antennaId) ?? SIM_ANTENNAS[0]!;
    const all: ScanPoint[] = [];
    const step = (stopHz - startHz) / (points - 1);
    for (let i = 0; i < points; i++) {
      const f = startHz + i * step;
      const g = distort(rlcGamma(preset.antenna, f), this.options.errorTerms(f));
      const n = this.options.noise;
      all.push({ freqHz: f, s11re: g.re + this.gauss() * n, s11im: g.im + this.gauss() * n });
    }

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
