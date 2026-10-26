import { useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { LearnTopic } from "../learn";
import { go, type Route, route, settings, updateSettings } from "../state";

interface Topic {
  id: LearnTopic;
  title: string;
  /** One line under the title, readable without opening the topic. */
  gist: string;
  body: () => ComponentChildren;
}

/** SWR, share of power reflected, return loss. Γ = (s−1)/(s+1). */
const SWR_ROWS: [string, string, string, string][] = [
  ["1.0:1", "0%", "∞", "Perfect"],
  ["1.5:1", "4%", "14 dB", "Excellent"],
  ["2.0:1", "11%", "9.5 dB", "Fine for most radios"],
  ["3.0:1", "25%", "6 dB", "Many radios cut power"],
  ["5.0:1", "44%", "3.5 dB", "Needs a tuner or a fix"],
];

const TOPICS: Topic[] = [
  {
    id: "swr",
    title: "SWR",
    gist: "How much of your power bounces back from the antenna.",
    body: () => (
      <>
        <p>
          SWR (standing wave ratio) compares what the antenna accepts with what it sends back down the coax. 1:1 means
          everything is accepted. The higher the number, the more bounces back.
        </p>
        <table class="learn-table">
          <thead>
            <tr>
              <th>SWR</th>
              <th>Reflected</th>
              <th>Return loss</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {SWR_ROWS.map(([s, p, rl, word]) => (
              <tr key={s}>
                <td class="num">{s}</td>
                <td class="num">{p}</td>
                <td class="num">{rl}</td>
                <td>{word}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Reflected power isn't all wasted: most of it bounces back up to the antenna again. What hurts is that modern
          radios protect themselves by cutting power above about 2:1, and lossy coax eats some of it on every trip.
        </p>
      </>
    ),
  },
  {
    id: "resonance",
    title: "Resonance, too long and too short",
    gist: "The frequency the antenna naturally wants to work at.",
    body: () => (
      <>
        <p>
          Every antenna has a frequency where its reactance (X) is zero: its resonant frequency. That's usually where SWR
          dips lowest. A longer wire resonates lower, a shorter one higher.
        </p>
        <ResonanceDiagram />
        <p>
          So if the dip sits <strong>below</strong> the band, the antenna is <strong>too long</strong>: shorten it. If
          it sits <strong>above</strong>, it's <strong>too short</strong>: add wire. As a rule of thumb, changing the
          length by 1% moves the resonance about 1% the other way. Tune works out the cut for you.
        </p>
      </>
    ),
  },
  {
    id: "bandwidth",
    title: "2:1 bandwidth",
    gist: "How wide a slice of the band you can use without a tuner.",
    body: () => (
      <>
        <p>
          The span of frequencies where SWR stays under 2:1. A wide bandwidth means you can move around the band freely.
          Thin wires and short antennas (like mobile whips) tend to be narrow; fat elements and fan dipoles are wider.
        </p>
        <p>
          A + after the number means the curve stays under 2:1 past the edge of the scan, so the real width is at least
          that much.
        </p>
      </>
    ),
  },
  {
    id: "impedance",
    title: "Impedance: R and X",
    gist: "Two numbers that say why the SWR is what it is.",
    body: () => (
      <>
        <p>
          Your radio and coax expect <strong>50 Ω</strong> with no reactance. The analyzer splits what the antenna
          looks like into two parts:
        </p>
        <ul>
          <li>
            <strong>R (resistance)</strong>: the part that takes power. Want it near 50 Ω. Much lower or higher means a
            mismatch even at resonance; that needs a matching network, not a cut.
          </li>
          <li>
            <strong>X (reactance)</strong>: the part that stores and returns energy. Want it near 0.{" "}
            <strong>+X</strong> (inductive) usually means you're above resonance, so the antenna is long for this
            frequency. <strong>−X</strong> (capacitive) usually means it's short.
          </li>
        </ul>
        <p>Low SWR needs both: R close to 50 and X close to 0.</p>
      </>
    ),
  },
  {
    id: "returnloss",
    title: "Return loss",
    gist: "SWR again, in decibels. Bigger is better.",
    body: () => (
      <p>
        Return loss says how much weaker the reflection is than what you sent, in dB. It carries the same information as
        SWR: 9.5 dB is 2:1, 14 dB is 1.5:1, 20 dB is about 1.2:1. Some analyzers and papers use it instead of SWR, so
        it's handy to recognize.
      </p>
    ),
  },
  {
    id: "smith",
    title: "Reading the Smith chart",
    gist: "A map of impedance. The center is a perfect match.",
    body: () => (
      <>
        <SmithDiagram />
        <ul>
          <li>
            The <strong>center</strong> is 50 Ω with no reactance: a perfect 1:1 match.
          </li>
          <li>
            The <strong>top half</strong> is inductive (+X), the <strong>bottom half</strong> capacitive (−X). The
            straight line across the middle is pure resistance, low on the left, high on the right.
          </li>
          <li>
            Circles around the center are <strong>constant SWR</strong>. The shaded circle above is 2:1: any point
            inside it is under 2:1. The closer the trace gets to the center, the better the match.
          </li>
          <li>As frequency rises the trace turns clockwise. Where it crosses the middle line, the antenna is resonant.</li>
        </ul>
      </>
    ),
  },
  {
    id: "segments",
    title: "Judging the part of the band you use",
    gist: "Why a CW antenna can be Good even if the phone end is high.",
    body: () => (
      <>
        <p>
          Few antennas cover a whole band under 1.5:1, and you don't need them to. Pick CW, FT8 / FT4 or SSB on the
          Check screen and the verdict is judged on that part of the band (the darker shading on the chart). The detail
          line still tells you how the rest of the band looks.
        </p>
        <p>
          CW and SSB use the US General and Extra sub-bands; FT8 / FT4 covers the usual digital windows. Pick Whole band
          to judge everything.
        </p>
      </>
    ),
  },
  {
    id: "calibration",
    title: "Calibration",
    gist: "Removes the cable's effect so you measure the antenna.",
    body: () => (
      <>
        <p>
          The NanoVNA, its cable and adapters all bend the measurement a little. Calibration measures three known
          loads, <strong>open</strong>, <strong>short</strong> and <strong>50 Ω load</strong>, at the end of the cable
          you'll actually use, then subtracts those errors from every later scan.
        </p>
        <p>
          Calibrate at the point where you'll connect the antenna. Redo it when you change cables or adapters, or after
          a week. One calibration covers every band from 160m to 6m.
        </p>
      </>
    ),
  },
  {
    id: "coax",
    title: "Coax, velocity factor and loss",
    gist: "Why the feedline matters to what you measure.",
    body: () => (
      <>
        <p>
          Signals travel slower in coax than in air. The <strong>velocity factor</strong> (VF) says how much: 0.66 for
          solid RG-58 and RG-213, about 0.78 to 0.85 for foam types. Test coax uses it to turn a reflection's travel time
          into a length, so it can find the cable end or a fault.
        </p>
        <p>
          <strong>Loss</strong> hides a bad match. A reflection loses power on the way to the antenna and again on the
          way back, so lossy coax makes SWR at the radio look better than it really is at the antenna. A long run of thin
          coax reading 1.3:1 on every band is a warning sign, not good news.
        </p>
      </>
    ),
  },
  {
    id: "tuner",
    title: "What a tuner does",
    gist: "Makes the radio happy; it doesn't fix the antenna.",
    body: () => (
      <>
        <p>
          An antenna tuner sits between the radio and the coax and transforms whatever the system looks like into 50 Ω,
          so the radio sees a low SWR and delivers full power. The mismatch between coax and antenna is still there, and
          so are its losses in the coax.
        </p>
        <p>
          That's fine for small mismatches or short, low-loss feedlines. For a big mismatch on a long run, fix the
          antenna (Tune) or match it at the feedpoint. The SWR meter is made for adjusting a tuner by hand.
        </p>
      </>
    ),
  },
];

export function Learn({ topic, back }: { topic?: LearnTopic; back?: Route }) {
  useEffect(() => {
    if (topic) document.getElementById(`learn-${topic}`)?.scrollIntoView({ block: "start" });
  }, [topic]);
  return (
    <>
      <div class="flow-head">
        <h2>Learn</h2>
        <button class="icon-btn" onClick={() => go(back ?? { name: "home" })}>
          {back ? "Back" : "Close"}
        </button>
      </div>
      <p class="muted">Short explanations of what the analyzer measures. Tap a topic to open it.</p>
      <div class="learn-list">
        {TOPICS.map((t) => (
          <details key={t.id} id={`learn-${t.id}`} class="learn-topic" open={t.id === topic}>
            <summary>
              <strong>{t.title}</strong>
              <span class="muted">{t.gist}</span>
            </summary>
            <div class="learn-body">{t.body()}</div>
          </details>
        ))}
      </div>
      <div class="actions single">
        <button class="btn" onClick={() => void updateSettings({ ...settings.value, introSeen: false }).then(() => go({ name: "home" }))}>
          Show the quick start again
        </button>
      </div>
    </>
  );
}

/** A small "more about this" link to a Learn topic. */
export function LearnLink({ topic, children }: { topic: LearnTopic; children?: ComponentChildren }) {
  return (
    <button class="link-btn learn-link" onClick={() => go({ name: "learn", topic, back: route.value })}>
      {children ?? "What does this mean?"}
    </button>
  );
}

/** Three SWR dips against a band: too long (left), right on, too short (right). */
function ResonanceDiagram() {
  const dip = (cx: number) => `M${cx - 46} 22 C${cx - 17} 22 ${cx - 11} 92 ${cx} 92 S${cx + 17} 22 ${cx + 46} 22`;
  return (
    <svg class="learn-figure" viewBox="0 0 320 130" role="img" aria-label="Three SWR dips. Left of the band: too long. In the band: on target. Right of the band: too short.">
      <rect x="128" y="10" width="64" height="94" fill="var(--trace-wash)" />
      <text x="160" y="122" text-anchor="middle" font-size="11" fill="var(--muted)">
        your band
      </text>
      <line x1="10" x2="310" y1="104" y2="104" stroke="var(--rule)" />
      <path d={dip(54)} fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="5 4" />
      <path d={dip(160)} fill="none" stroke="var(--trace)" stroke-width="2.5" />
      <path d={dip(266)} fill="none" stroke="var(--muted)" stroke-width="2" stroke-dasharray="5 4" />
      <text x="54" y="122" text-anchor="middle" font-size="11" fill="var(--ink)">
        too long
      </text>
      <text x="266" y="122" text-anchor="middle" font-size="11" fill="var(--ink)">
        too short
      </text>
      <text x="300" y="16" text-anchor="end" font-size="10" fill="var(--muted)">
        frequency →
      </text>
    </svg>
  );
}

/** The Smith chart's landmarks: center, halves, resistance line, a 2:1 circle. */
function SmithDiagram() {
  const cx = 128;
  const cy = 100;
  const r = 78;
  return (
    <svg class="learn-figure" viewBox="0 0 320 200" role="img" aria-label="Smith chart: center is a perfect match, top half inductive, bottom half capacitive, left low resistance, right high resistance.">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--rule)" stroke-width="1.5" />
      <circle cx={cx} cy={cy} r={r / 3} fill="var(--good-wash)" stroke="var(--good)" stroke-dasharray="4 3" />
      <line x1={cx - r} x2={cx + r} y1={cy} y2={cy} stroke="var(--rule)" />
      <circle cx={cx} cy={cy} r="4" fill="var(--trace)" />
      <g font-size="11" fill="var(--ink)">
        <text x={cx} y={cy - r - 6} text-anchor="middle">
          inductive (+X)
        </text>
        <text x={cx} y={cy + r + 14} text-anchor="middle">
          capacitive (−X)
        </text>
        <text x={cx - r - 4} y={cy - 6} text-anchor="end">
          low R
        </text>
        <text x={cx + r + 4} y={cy - 6}>
          high R
        </text>
      </g>
      <g font-size="11" fill="var(--muted)">
        <line x1={cx + 4} y1={cy + 3} x2="240" y2="132" stroke="var(--muted)" />
        <text x="244" y="136">50 Ω, perfect</text>
        <line x1={cx + 18} y1={cy - 20} x2="240" y2="60" stroke="var(--muted)" />
        <text x="244" y="58">inside: under</text>
        <text x="244" y="71">2:1 SWR</text>
      </g>
    </svg>
  );
}
