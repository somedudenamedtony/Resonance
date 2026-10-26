import type { ClientMessage } from "./protocol";

/** A duplex link to a bridge: JSON text out, JSON text or binary in. */
export interface Transport {
  readonly kind: "websocket" | "simulator";
  /** Human-readable target, e.g. "ws://192.168.4.1/ws" or "Simulator". */
  readonly label: string;
  connect(): void;
  close(): void;
  send(msg: ClientMessage): void;
  sendBinary(buf: ArrayBuffer): void;
  onOpen?: () => void;
  onClose?: () => void;
  onText?: (text: string) => void;
  onBinary?: (buf: ArrayBuffer) => void;
}

export class WebSocketTransport implements Transport {
  readonly kind = "websocket" as const;
  private ws: WebSocket | null = null;
  onOpen?: () => void;
  onClose?: () => void;
  onText?: (text: string) => void;
  onBinary?: (buf: ArrayBuffer) => void;

  constructor(readonly label: string) {}

  connect(): void {
    this.close();
    const ws = new WebSocket(this.label);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => this.onOpen?.();
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.onClose?.();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.onText?.(ev.data);
      else this.onBinary?.(ev.data as ArrayBuffer);
    };
    this.ws = ws;
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.close();
    }
  }

  send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("bridge is not connected");
    this.ws.send(JSON.stringify(msg));
  }

  sendBinary(buf: ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("bridge is not connected");
    this.ws.send(buf);
  }
}

/**
 * Whether the page came from a bridge: its own network (192.168.4.1), or home Wi-Fi, where it
 * has whatever private address the router gave it. Anywhere else (localhost, a dev server) the
 * app runs the simulator.
 */
export function isBridgeHost(host: string): boolean {
  if (host.endsWith(".local")) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
