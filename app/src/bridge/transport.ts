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
