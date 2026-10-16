/**
 * Runs the real C bridge core (resonance-bridge-host) wired to an emulated NanoVNA, and
 * exposes it to apps over a real WebSocket at ws://host:port/ws — the same interface the
 * ESP32 bridge serves. Optionally serves a built app bundle at http://host:port/.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { NanoVnaEmulator, type NanoVnaOptions } from "./nanovna";

const K_TEXT = 0x00;
const K_BINARY = 0x01;
const K_CONTROL = 0x02;
const K_LOG = 0x03;

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_HOST_BINARY = resolve(REPO_ROOT, "firmware/build-host/resonance-bridge-host");

export interface EmulatedBridgeOptions {
  /** Port for HTTP + WebSocket. 0 picks a free port. */
  port?: number;
  host?: string;
  binaryPath?: string;
  nanovna?: Partial<NanoVnaOptions>;
  /** Plug the emulated NanoVNA in at start. Default true. */
  attached?: boolean;
  /** Directory with a built app to serve at /. */
  serveDir?: string;
  onLog?: (line: string) => void;
}

export function encodeHostFrame(kind: number, payload: Uint8Array): Buffer {
  const b = Buffer.alloc(5 + payload.length);
  b[0] = kind;
  b.writeUInt32LE(payload.length, 1);
  b.set(payload, 5);
  return b;
}

/** Incremental decoder for frames from the bridge host's stdout. */
export class HostFrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private onFrame: (kind: number, payload: Buffer) => void) {}
  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32LE(1);
      if (this.buf.length < 5 + len) break;
      const kind = this.buf[0]!;
      const payload = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      this.onFrame(kind, payload);
    }
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

export class EmulatedBridge {
  readonly nanovna: NanoVnaEmulator;
  private child: ChildProcess | null = null;
  private serial: Socket | null = null;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private attached = false;
  private exited: Promise<void> | null = null;
  readonly logs: string[] = [];

  constructor(private readonly opts: EmulatedBridgeOptions = {}) {
    this.nanovna = new NanoVnaEmulator(opts.nanovna);
  }

  /** WebSocket URL apps connect to. */
  url = "";
  /** HTTP origin. */
  origin = "";

  async start(): Promise<this> {
    const bin = this.opts.binaryPath ?? DEFAULT_HOST_BINARY;
    if (!existsSync(bin)) {
      throw new Error(`bridge host binary not found at ${bin}. Run: npm run build:host -w @resonance/emulator`);
    }
    const child = spawn(bin, [], {
      stdio: ["pipe", "pipe", "inherit", "pipe"],
      env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0" },
    });
    this.child = child;
    this.exited = new Promise((r) => child.once("exit", () => r()));
    this.serial = child.stdio[3] as Socket;

    // Serial link: emulator <-> bridge.
    this.nanovna.onOutput = (bytes) => {
      if (this.attached) this.serial?.write(bytes);
    };
    this.serial.on("data", (d: Buffer) => {
      if (this.attached) this.nanovna.input(d);
    });
    this.serial.on("error", () => {});

    // Bridge output -> WebSocket clients.
    const decoder = new HostFrameDecoder((kind, payload) => {
      if (kind === K_LOG) {
        const line = payload.toString("utf8");
        this.logs.push(line);
        this.opts.onLog?.(line);
        return;
      }
      for (const ws of this.wss?.clients ?? []) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (kind === K_TEXT) ws.send(payload.toString("utf8"));
        else if (kind === K_BINARY) ws.send(payload, { binary: true });
      }
    });
    child.stdout!.on("data", (d: Buffer) => decoder.push(d));

    // HTTP + WebSocket.
    const serveDir = this.opts.serveDir;
    this.server = createServer((req, res) => {
      if (!serveDir) {
        res.writeHead(404).end("Resonance emulated bridge. WebSocket at /ws\n");
        return;
      }
      const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      let file = resolve(join(serveDir, urlPath));
      if (!file.startsWith(resolve(serveDir))) {
        res.writeHead(403).end();
        return;
      }
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(serveDir, "index.html");
      if (!existsSync(file)) {
        res.writeHead(404).end("app not built; run npm run build");
        return;
      }
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    });
    this.wss = new WebSocketServer({ server: this.server, path: "/ws" });
    this.wss.on("connection", (ws) => {
      this.control("client");
      ws.on("message", (data, isBinary) => {
        if (isBinary) return; // OTA chunks not supported on the host
        this.send(K_TEXT, Buffer.from(data.toString(), "utf8"));
      });
    });

    await new Promise<void>((r) => this.server!.listen(this.opts.port ?? 0, this.opts.host ?? "127.0.0.1", r));
    const addr = this.server.address() as AddressInfo;
    const host = addr.address.includes(":") ? `[${addr.address}]` : addr.address;
    this.origin = `http://${host}:${addr.port}`;
    this.url = `ws://${host}:${addr.port}/ws`;

    if (this.opts.attached ?? true) this.attach();
    return this;
  }

  /** Plug the NanoVNA in (USB enumerated). */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.control("attach");
    this.nanovna.attach();
  }

  /** Unplug the NanoVNA. */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.control("detach");
  }

  /** Wait until the bridge logs a line matching `re`, looking at lines from index `since`. */
  async waitForLog(re: RegExp, timeoutMs = 5000, since = 0): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let seen = since;
    while (Date.now() < deadline) {
      for (; seen < this.logs.length; seen++) if (re.test(this.logs[seen]!)) return this.logs[seen]!;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for bridge log ${re}; got:\n${this.logs.join("\n")}`);
  }

  async stop(): Promise<void> {
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    if (this.child && this.child.exitCode === null) {
      this.child.stdin?.end();
      this.child.kill("SIGTERM");
    }
    await this.exited;
  }

  private control(cmd: "attach" | "detach" | "client"): void {
    this.send(K_CONTROL, Buffer.from(cmd, "utf8"));
  }

  private send(kind: number, payload: Uint8Array): void {
    this.child?.stdin?.write(encodeHostFrame(kind, payload));
  }
}
