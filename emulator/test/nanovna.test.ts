import { describe, expect, it } from "vitest";
import { IDENTITY_TERMS } from "@resonance/analysis";
import { myAtoui, NanoVnaEmulator } from "../src/nanovna";

const dec = new TextDecoder();

function harness(opts: ConstructorParameters<typeof NanoVnaEmulator>[0] = {}) {
  const emu = new NanoVnaEmulator({ msPerPoint: 0, noise: 0, errorTerms: () => IDENTITY_TERMS, ...opts });
  const chunks: Uint8Array[] = [];
  emu.onOutput = (b) => chunks.push(b);
  const output = () => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const all = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      all.set(c, o);
      o += c.length;
    }
    return all;
  };
  const type = async (s: string) => {
    emu.input(new TextEncoder().encode(s));
    await new Promise((r) => setTimeout(r, 5));
  };
  const clear = () => (chunks.length = 0);
  return { emu, output, text: () => dec.decode(output()), type, clear };
}

describe("NanoVNA shell emulator", () => {
  it("prints a banner and prompt when attached", () => {
    const h = harness();
    h.emu.attach();
    expect(h.text()).toBe("\r\nNanoVNA Shell\r\nch> ");
  });

  it("echoes input, ends the line on CR, answers, then prompts", async () => {
    const h = harness();
    await h.type("version\r");
    expect(h.text()).toBe("version\r\n1.2.40-emu\r\nch> ");
  });

  it("answers unknown commands with name?", async () => {
    const h = harness();
    await h.type("frobnicate\r");
    expect(h.text()).toBe("frobnicate\r\nfrobnicate?\r\nch> ");
  });

  it("reports max points in info like NanoVNA-D", async () => {
    const h = harness();
    await h.type("info\r");
    expect(h.text()).toMatch(/Board: NanoVNA-H 4/);
    expect(h.text()).toMatch(/\[p:401,/);
  });

  it("text scan prints freq re im per line", async () => {
    const h = harness();
    await h.type("scan 14000000 14100000 3 3\r");
    const lines = h.text().split("\r\n");
    expect(lines[0]).toBe("scan 14000000 14100000 3 3");
    expect(lines[1]).toMatch(/^14000000 -?\d+\.\d{6} -?\d+\.\d{6} $/);
    expect(lines[3]).toMatch(/^14100000 /);
    expect(lines[4]).toBe("ch> ");
  });

  it("binary scan matches NanoVNA-D layout: u16 mask, u16 points, u32 freq, f32 pairs", async () => {
    const h = harness();
    await h.type("scan 7000000 7300000 4 131\r"); // 0x83: freq + S11, binary
    const out = h.output();
    const echo = "scan 7000000 7300000 4 131\r\n".length;
    const dv = new DataView(out.buffer, out.byteOffset + echo);
    expect(dv.getUint16(0, true)).toBe(131);
    expect(dv.getUint16(2, true)).toBe(4);
    expect(dv.getUint32(4, true)).toBe(7_000_000);
    expect(dv.getUint32(4 + 3 * 12, true)).toBe(7_300_000);
    expect(out.length).toBe(echo + 4 + 4 * 12 + 4);
    expect(dec.decode(out.subarray(out.length - 4))).toBe("ch> ");
  });

  it("scan_bin forces binary output", async () => {
    const h = harness();
    await h.type("scan_bin 7000000 7300000 2 3\r");
    const out = h.output();
    const dv = new DataView(out.buffer, out.byteOffset + "scan_bin 7000000 7300000 2 3\r\n".length);
    expect(dv.getUint16(0, true)).toBe(0x83);
  });

  it("classic dialect: 101 points max and no binary", async () => {
    const h = harness({ dialect: "classic" });
    await h.type("scan 1000000 2000000 201 3\r");
    expect(h.text()).toMatch(/sweep points exceeds range 101/);
    h.clear();
    await h.type("scan 1000000 2000000 2 131\r");
    expect(h.text().split("\r\n")[1]).toMatch(/^1000000 /); // text, not binary
    h.clear();
    await h.type("scan_bin 1 2 2 3\r");
    expect(h.text()).toMatch(/scan_bin\?/);
  });

  it("rejects bad ranges like the real firmware", async () => {
    const h = harness();
    await h.type("scan 2000000 1000000\r");
    expect(h.text()).toMatch(/frequency range is invalid/);
  });

  it("applies raw error terms only when calibration is skipped (mask 0x08)", async () => {
    const h = harness({
      port1: { kind: "load" },
      errorTerms: () => ({ ed: { re: 0.1, im: 0 }, es: { re: 0, im: 0 }, er: { re: 1, im: 0 } }),
    });
    await h.type("scan 1000000 1000000 1 3\r");
    expect(h.text()).toMatch(/1000000 0\.000000 0\.000000/);
    h.clear();
    await h.type("scan 1000000 1000000 1 11\r");
    expect(h.text()).toMatch(/1000000 0\.100000 0\.000000/);
  });

  it("parses numbers like my_atoui", () => {
    expect(myAtoui("155")).toBe(155);
    expect(myAtoui("0x9b")).toBe(155);
    expect(myAtoui("0b11")).toBe(3);
    expect(myAtoui("12abc")).toBe(12);
  });
});
