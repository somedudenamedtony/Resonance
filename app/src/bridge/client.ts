import { c, type Complex, type Sweep } from "@resonance/analysis";
import {
  decodeCaptureFrame,
  decodeScanFrame,
  encodeOtaFrame,
  OTA_CHUNK_BYTES,
  type UpdateTarget,
  FRAME_CAPTURE,
  frameKind,
  type DeviceStatus,
  parseServerMessage,
  PROTOCOL_VERSION,
  type ReleaseUpdateStatus,
  type ServerMessage,
  type WifiStatus,
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

export interface Capture {
  width: number;
  height: number;
  format: "rgb565be";
  data: Uint8Array;
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
  /** Sent by bridge firmware that reports Wi-Fi; stays null with older firmware. */
  wifi: WifiStatus | null = null;
  /** Sent by bridge firmware that can update itself from GitHub; null otherwise. */
  release: ReleaseUpdateStatus | null = null;
  onChange?: () => void;

  private nextId = 1;
  private pending: PendingScan | null = null;
  private rawWaiters: Array<(text: string) => void> = [];
  private okWaiters: Array<{ for: string; resolve: () => void; reject: (e: Error) => void }> = [];
  private capturing: {
    width: number;
    height: number;
    data: Uint8Array | null;
    resolve: (c: Capture) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private updating: {
    data: Uint8Array;
    sent: number;
    onProgress?: (sent: number, total: number) => void;
    resolve: () => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
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
      this.wifi = null;
      this.release = null;
      this.failPending(new BridgeError("disconnected", "Lost the connection to the bridge."));
      this.failUpdate(new BridgeError("disconnected", "Lost the connection during the update."));
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

  /** The NanoVNA's screen as big-endian RGB565. */
  capture(timeoutMs = 20_000): Promise<Capture> {
    if (this.link !== "open") return Promise.reject(new BridgeError("disconnected", "The bridge isn't connected."));
    if (this.capturing) return Promise.reject(new BridgeError("busy", "Already reading the screen."));
    return new Promise<Capture>((resolve, reject) => {
      const timer = setTimeout(() => this.failCapture(new BridgeError("timeout", "The screen didn't arrive.")), timeoutMs);
      this.capturing = { width: 0, height: 0, data: null, resolve, reject, timer };
      try {
        this.transport.send({ v: PROTOCOL_VERSION, type: "capture" });
      } catch (e) {
        this.failCapture(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private failCapture(err: Error): void {
    const c = this.capturing;
    if (!c) return;
    clearTimeout(c.timer);
    this.capturing = null;
    c.reject(err);
  }

  /**
   * Send a firmware or web-app image. One chunk in flight at a time: each waits for `ota.ack`.
   * Resolves once the bridge has verified it (it then reboots).
   */
  update(target: UpdateTarget, data: Uint8Array, onProgress?: (sent: number, total: number) => void): Promise<void> {
    if (this.link !== "open") return Promise.reject(new BridgeError("disconnected", "The bridge isn't connected."));
    if (this.updating) return Promise.reject(new BridgeError("busy", "An update is already running."));
    if (this.pending || this.capturing) return Promise.reject(new BridgeError("busy", "Wait for the scan to finish."));
    return new Promise<void>((resolve, reject) => {
      this.updating = { data, sent: 0, onProgress, resolve, reject, timer: setTimeout(() => {}, 0) };
      this.armUpdateTimer();
      try {
        this.transport.send({ v: PROTOCOL_VERSION, type: "ota.begin", target, size: data.length });
      } catch (e) {
        this.failUpdate(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private armUpdateTimer(): void {
    const u = this.updating;
    if (!u) return;
    clearTimeout(u.timer);
    u.timer = setTimeout(() => this.failUpdate(new BridgeError("timeout", "The bridge stopped answering.")), 20_000);
  }

  private sendNextChunk(): void {
    const u = this.updating;
    if (!u) return;
    const n = Math.min(OTA_CHUNK_BYTES, u.data.length - u.sent);
    this.armUpdateTimer();
    try {
      this.transport.sendBinary(encodeOtaFrame(u.sent, u.data.subarray(u.sent, u.sent + n)));
    } catch (e) {
      this.failUpdate(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private failUpdate(err: Error): void {
    const u = this.updating;
    if (!u) return;
    clearTimeout(u.timer);
    this.updating = null;
    u.reject(err);
  }

  /** Ask the bridge to look for a newer release on GitHub. Resolves once it has started. */
  checkForUpdate(): Promise<void> {
    return this.releaseRequest("update.check");
  }

  /**
   * Ask the bridge to download and install the latest release (firmware, then app). Progress
   * arrives in `release`; when it's done the bridge restarts.
   */
  installUpdate(): Promise<void> {
    if (this.updating) return Promise.reject(new BridgeError("busy", "An update from a file is running."));
    return this.releaseRequest("update.install");
  }

  private releaseRequest(type: "update.check" | "update.install"): Promise<void> {
    if (this.link !== "open") return Promise.reject(new BridgeError("disconnected", "The bridge isn't connected."));
    return new Promise((resolve, reject) => {
      try {
        this.transport.send({ v: PROTOCOL_VERSION, type });
        // The bridge answers with a fresh `update` message, or an error.
        this.okWaiters.push({ for: "update", resolve, reject });
      } catch (e) {
        reject(e);
      }
    });
  }

  /** Ask the bridge to join home Wi-Fi (sta) or stay hotspot-only (ap). It restarts after "ok". */
  setWifi(mode: "ap" | "sta", ssid?: string, password?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.transport.send({ v: PROTOCOL_VERSION, type: "wifi.set", mode, ssid, password });
        this.okWaiters.push({ for: "wifi.set", resolve, reject });
      } catch (e) {
        reject(e);
      }
    });
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
      case "wifi": {
        const { v: _v, type: _t, ...status } = msg;
        this.wifi = status;
        this.changed();
        break;
      }
      case "update": {
        const { v: _v, type: _t, ...status } = msg;
        this.release = status;
        const i = this.okWaiters.findIndex((w) => w.for === "update");
        if (i >= 0) this.okWaiters.splice(i, 1)[0]!.resolve();
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
      case "capture.begin":
        if (this.capturing) {
          this.capturing.width = msg.width;
          this.capturing.height = msg.height;
          this.capturing.data = new Uint8Array(msg.width * msg.height * 2);
        }
        break;
      case "capture.end": {
        const c = this.capturing;
        if (!c || !c.data) break;
        clearTimeout(c.timer);
        this.capturing = null;
        c.resolve({ width: c.width, height: c.height, format: "rgb565be", data: c.data });
        break;
      }
      case "ota.ack": {
        const u = this.updating;
        if (!u) break;
        u.sent = msg.received;
        u.onProgress?.(u.sent, u.data.length);
        if (u.sent < u.data.length) this.sendNextChunk();
        else this.armUpdateTimer();
        break;
      }
      case "error": {
        if (msg.id === undefined && this.updating) {
          this.failUpdate(new BridgeError(msg.code, msg.message));
          break;
        }
        if (msg.id === undefined && this.capturing) {
          this.failCapture(new BridgeError(msg.code, msg.message));
          break;
        }
        if (msg.id === undefined && this.okWaiters.length) {
          this.okWaiters.shift()!.reject(new BridgeError(msg.code, msg.message));
          break;
        }
        const p = this.pending;
        if (p && (msg.id === undefined || msg.id === p.id)) this.failPending(new BridgeError(msg.code, msg.message));
        break;
      }
      case "raw.reply":
        this.rawWaiters.shift()?.(msg.text);
        break;
      case "ok": {
        const u = this.updating;
        if (u && msg.for === "ota.begin") {
          this.sendNextChunk();
          break;
        }
        if (u && msg.for === "ota.end") {
          clearTimeout(u.timer);
          this.updating = null;
          u.resolve();
          break;
        }
        const i = this.okWaiters.findIndex((w) => w.for === msg.for);
        if (i >= 0) this.okWaiters.splice(i, 1)[0]!.resolve();
        break;
      }
      case "scan.begin":
        break;
    }
  }

  private handleBinary(buf: ArrayBuffer): void {
    if (frameKind(buf) === FRAME_CAPTURE) {
      const c = this.capturing;
      if (!c?.data) return;
      const { offset, data } = decodeCaptureFrame(buf);
      if (offset + data.length <= c.data.length) c.data.set(data, offset);
      return;
    }
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
