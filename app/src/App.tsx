import { StatusBar } from "./components/StatusBar";
import { Calibrate } from "./screens/Calibrate";
import { Check } from "./screens/Check";
import { Connect } from "./screens/Connect";
import { Home } from "./screens/Home";
import { go, route } from "./state";

export function App() {
  const r = route.value;
  const tab = r.name === "soon" && (r.job === "Antennas" || r.job === "Settings") ? r.job : "Home";

  return (
    <>
      <main class="shell">
        <StatusBar />
        {r.name === "home" && <Home />}
        {r.name === "check" && <Check />}
        {r.name === "connect" && <Connect />}
        {r.name === "calibrate" && <Calibrate />}
        {r.name === "soon" && <Soon job={r.job} milestone={r.milestone} />}
      </main>
      <nav class="tabbar" aria-label="Main">
        <div class="tabbar-inner">
          <button class="tab" aria-current={tab === "Home" ? "page" : undefined} onClick={() => go({ name: "home" })}>
            Home
          </button>
          <button
            class="tab"
            aria-current={tab === "Antennas" ? "page" : undefined}
            onClick={() => go({ name: "soon", job: "Antennas", milestone: "M5" })}
          >
            Antennas
          </button>
          <button
            class="tab"
            aria-current={tab === "Settings" ? "page" : undefined}
            onClick={() => go({ name: "soon", job: "Settings", milestone: "M5" })}
          >
            Settings
          </button>
        </div>
      </nav>
    </>
  );
}

function Soon({ job, milestone }: { job: string; milestone: string }) {
  return (
    <>
      <div class="flow-head">
        <h2>{job}</h2>
        <button class="icon-btn" onClick={() => go({ name: "home" })}>
          Close
        </button>
      </div>
      <div class="soon">
        <p>{job} isn't built yet. It's planned for milestone {milestone}.</p>
        <p class="muted" style={{ marginTop: "8px" }}>
          Check my antenna works now against the simulator.
        </p>
      </div>
    </>
  );
}
