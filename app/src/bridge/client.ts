import { c, type Complex, type Sweep } from "@resonance/analysis";
import {
  decodeScanFrame,
  type DeviceStatus,
  parseServerMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "./protocol";
import type { Transport } from "./transport";

export type LinkState = "connecting" | "open" | "closed";

export interface ScanRequest {
  startHz: number;
  stopHz: number;
  points: number;
}

export interface ScanProgress {
  /** Points received so far, in order. */
  received: number;
  total: number;
  /** Partial sweep with the points received so far. */
  partial: Sweep;
}

export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface PendingScan {
  id: number;
  total: number;
  freqHz: number[];
  s11: Complex[];
  onProgress?: (p: ScanProgress) => void;
  resolve: (s: Sweep) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const APP_VERSION = "0.1.0";

/**
 * Talks to a bridge (real or simulated) over a Transport. Owns reconnects, the device
 * status, and turning binary frames back into a Sweep.
 */
export class BridgeClient {
  link: LinkState = "closed";
  device: DeviceStatus | null = null;
  onChange?: () => void;

  private nextId = 1;
  private pending: PendingScan | null = null;
  private rawWaiters: Array<(text: string) => void> = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(readonly transport: Transport) {
    transport.onOpen = () => {
      this.link = "open";
      this.transport.send({ v: PROTOCOL_VERSION, type: "hello", appVersion: APP_VERSION });
      this.changed();
    };
    transport.onClose = () => {
      this.link = "closed";
      this.device = null;
      this.failPending(new BridgeError("disconnected", "Lost the connection to the bridge."));
      this.changed();
      this.scheduleReconnect();
    };
    transport.onText = (t) => this.handleText(t);
    transport.onBinary = (b) => this.handleBinary(b);
  }

  start(): void {
    this.stopped = false;
    this.link = "connecting";
    this.changed();
    this.transport.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.transport.close();
    this.link = "closed";
    this.changed();
  }

  get scanning(): boolean {
    return this.pending !== null;
  }

  scan(req: ScanRequest, onProgress?: (p: ScanProgress) => void, timeoutMs = 20_000): Promise<Sweep> {
    if (this.link !== "open") return Promise.reject(new BridgeError("disconnected", "The bridge isn't connected."));
    if (this.pending) return Promise.reject(new BridgeError("busy", "A scan is already running."));
    const id = this.nextId++ & 0xffff;
    return new Promise<Sweep>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failPending(new BridgeError("timeout", "The scan took too long. Check the NanoVNA and try again."));
      }, timeoutMs);
      this.pending = { id, total: req.points, freqHz: [], s11: [], onProgress, resolve, reject, timer };
      try {
        this.transport.send({ v: PROTOCOL_VERSION, type: "scan", id, ...req, ports: "s11" });
      } catch (e) {
        this.failPending(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  cancelScan(): void {
    const p = this.pending;
    if (!p) return;
    try {
      this.transport.send({ v: PROTOCOL_VERSION, type: "cancel", id: p.id });
    } catch {
      /* link already gone */
    }
    this.failPending(new BridgeError("cancelled", "Scan cancelled."));
  }

  raw(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        this.transport.send({ v: PROTOCOL_VERSION, type: "raw", command });
        this.rawWaiters.push(resolve);
      } catch (e) {
        reject(e);
      }
    });
  }

  private handleText(text: string): void {
    let msg: ServerMessage;
    try {
      msg = parseServerMessage(text);
    } catch {
      return; // ignore messages from a newer protocol we don't understand
    }
    switch (msg.type) {
      case "device": {
        const { v: _v, type: _t, ...status } = msg;
        this.device = status;
        if (!status.connected) this.failPending(new BridgeError("no_device", "The NanoVNA was disconnected."));
        this.changed();
        break;
      }
      case "scan.end": {
        const p = this.pending;
        if (!p || p.id !== msg.id) return;
        if (msg.cancelled) return;
        if (p.freqHz.length !== p.total) {
          this.failPending(new BridgeError("internal", `Scan ended with ${p.freqHz.length} of ${p.total} points.`));
          return;
        }
        clearTimeout(p.timer);
        this.pending = null;
        p.resolve({ freqHz: p.freqHz, s11: p.s11 });
        this.changed();
        break;
      }
      case "error": {
        const p = this.pending;
        if (p && (msg.id === undefined || msg.id === p.id)) this.failPending(new BridgeError(msg.code, msg.message));
        break;
      }
      case "raw.reply":
        this.rawWaiters.shift()?.(msg.text);
        break;
      case "scan.begin":
      case "ok":
        break;
    }
  }

  private handleBinary(buf: ArrayBuffer): void {
    const p = this.pending;
    if (!p) return;
    let frame;
    try {
      frame = decodeScanFrame(buf);
    } catch (e) {
      this.failPending(new BridgeError("internal", `Bad data from the bridge: ${(e as Error).message}`));
      return;
    }
    if (frame.scanId !== p.id) return;
    if (frame.offset !== p.freqHz.length) {
      this.failPending(new BridgeError("internal", "Scan data arrived out of order."));
      return;
    }
    for (const pt of frame.points) {
      p.freqHz.push(pt.freqHz);
      p.s11.push(c(pt.s11re, pt.s11im));
    }
    p.onProgress?.({ received: p.freqHz.length, total: p.total, partial: { freqHz: p.freqHz, s11: p.s11 } });
  }

  private failPending(err: Error): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    p.reject(err);
    this.changed();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.start();
    }, 2000);
  }

  private changed(): void {
    this.onChange?.();
  }
}
