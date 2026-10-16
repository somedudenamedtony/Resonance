/**
 * Bridge protocol v1. Must match docs/PROTOCOL.md and the firmware byte for byte.
 */
export const PROTOCOL_VERSION = 1 as const;

export type Ports = "s11" | "s11+s21";

// ---- App → bridge ----
export type ClientMessage =
  | { v: 1; type: "hello"; appVersion: string }
  | { v: 1; type: "scan"; id: number; startHz: number; stopHz: number; points: number; ports: Ports }
  | { v: 1; type: "cancel"; id: number }
  | { v: 1; type: "raw"; command: string }
  | { v: 1; type: "wifi.set"; mode: "ap" | "sta"; ssid?: string; password?: string }
  | { v: 1; type: "ota.begin"; target: "firmware" | "app"; size: number };

// ---- Bridge → app ----
export interface DeviceStatus {
  connected: boolean;
  model?: string;
  firmware?: string;
  maxPoints?: number;
  bridgeVersion: string;
}

export type ErrorCode = "no_device" | "timeout" | "busy" | "bad_request" | "internal";

export type ServerMessage =
  | ({ v: 1; type: "device" } & DeviceStatus)
  | { v: 1; type: "scan.begin"; id: number; points: number; ports: Ports }
  | { v: 1; type: "scan.end"; id: number; durationMs: number; cancelled?: boolean }
  | { v: 1; type: "raw.reply"; command: string; text: string }
  | { v: 1; type: "ok"; for: string }
  | { v: 1; type: "error"; code: ErrorCode; message: string; id?: number };

// ---- Binary frames ----
export const FRAME_SCAN = 0x01;
export const FRAME_OTA = 0x02;
export const FLAG_S21 = 0x01;
export const HEADER_BYTES = 8;
export const MAX_FRAME_BYTES = 4096;

export interface ScanPoint {
  freqHz: number;
  s11re: number;
  s11im: number;
  s21re?: number;
  s21im?: number;
}

export interface ScanFrame {
  scanId: number;
  offset: number;
  hasS21: boolean;
  points: ScanPoint[];
}

export const recordBytes = (hasS21: boolean) => (hasS21 ? 24 : 16);

/** Max records that fit a frame under MAX_FRAME_BYTES. */
export const recordsPerFrame = (hasS21: boolean) =>
  Math.floor((MAX_FRAME_BYTES - HEADER_BYTES) / recordBytes(hasS21));

export function encodeScanFrame(frame: ScanFrame): ArrayBuffer {
  const rb = recordBytes(frame.hasS21);
  const buf = new ArrayBuffer(HEADER_BYTES + rb * frame.points.length);
  const dv = new DataView(buf);
  dv.setUint8(0, FRAME_SCAN);
  dv.setUint8(1, frame.hasS21 ? FLAG_S21 : 0);
  dv.setUint16(2, frame.scanId, true);
  dv.setUint16(4, frame.offset, true);
  dv.setUint16(6, frame.points.length, true);
  frame.points.forEach((p, i) => {
    const o = HEADER_BYTES + i * rb;
    dv.setFloat64(o, p.freqHz, true);
    dv.setFloat32(o + 8, p.s11re, true);
    dv.setFloat32(o + 12, p.s11im, true);
    if (frame.hasS21) {
      dv.setFloat32(o + 16, p.s21re ?? 0, true);
      dv.setFloat32(o + 20, p.s21im ?? 0, true);
    }
  });
  return buf;
}

export function decodeScanFrame(buf: ArrayBuffer): ScanFrame {
  if (buf.byteLength < HEADER_BYTES) throw new Error("frame shorter than header");
  const dv = new DataView(buf);
  const kind = dv.getUint8(0);
  if (kind !== FRAME_SCAN) throw new Error(`not a scan frame (kind 0x${kind.toString(16)})`);
  const hasS21 = (dv.getUint8(1) & FLAG_S21) !== 0;
  const scanId = dv.getUint16(2, true);
  const offset = dv.getUint16(4, true);
  const count = dv.getUint16(6, true);
  const rb = recordBytes(hasS21);
  if (buf.byteLength !== HEADER_BYTES + rb * count) {
    throw new Error(`frame length ${buf.byteLength} does not match ${count} records`);
  }
  const points: ScanPoint[] = [];
  for (let i = 0; i < count; i++) {
    const o = HEADER_BYTES + i * rb;
    const p: ScanPoint = {
      freqHz: dv.getFloat64(o, true),
      s11re: dv.getFloat32(o + 8, true),
      s11im: dv.getFloat32(o + 12, true),
    };
    if (hasS21) {
      p.s21re = dv.getFloat32(o + 16, true);
      p.s21im = dv.getFloat32(o + 20, true);
    }
    points.push(p);
  }
  return { scanId, offset, hasS21, points };
}

export function parseServerMessage(text: string): ServerMessage {
  const m = JSON.parse(text) as Partial<ServerMessage>;
  if (m.v !== PROTOCOL_VERSION || typeof m.type !== "string") {
    throw new Error(`unsupported message: ${text.slice(0, 80)}`);
  }
  return m as ServerMessage;
}
