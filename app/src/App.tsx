import { Icon } from "./components/Icon";
import { StatusBar } from "./components/StatusBar";
import { Advanced } from "./screens/Advanced";
import { Antennas, Profile } from "./screens/Antennas";
import { Calibrate } from "./screens/Calibrate";
import { Check } from "./screens/Check";
import { Coax } from "./screens/Coax";
import { Connect } from "./screens/Connect";
import { Home } from "./screens/Home";
import { Meter } from "./screens/Meter";
import { Settings } from "./screens/Settings";
import { Tune } from "./screens/Tune";
import { go, route } from "./state";

export function App() {
  const r = route.value;
  const tab =
    r.name === "antennas" || r.name === "profile" ? "Antennas" : r.name === "settings" ? "Settings" : "Home";

  return (
    <>
      <main class="shell" key={r.name}>
        <StatusBar />
        {r.name === "home" && <Home />}
        {r.name === "check" && <Check />}
        {r.name === "connect" && <Connect />}
        {r.name === "calibrate" && <Calibrate />}
        {r.name === "tune" && <Tune />}
        {r.name === "meter" && <Meter />}
        {r.name === "antennas" && <Antennas />}
        {r.name === "profile" && <Profile id={r.id} />}
        {r.name === "settings" && <Settings />}
        {r.name === "coax" && <Coax />}
        {r.name === "advanced" && <Advanced />}
        {r.name === "soon" && <Soon job={r.job} milestone={r.milestone} />}
      </main>
      <nav class="tabbar" aria-label="Main">
        <div class="tabbar-inner">
          <button class="tab" aria-current={tab === "Home" ? "page" : undefined} onClick={() => go({ name: "home" })}>
            <Icon name="home" />
            <span>Home</span>
          </button>
          <button
            class="tab"
            aria-current={tab === "Antennas" ? "page" : undefined}
            onClick={() => go({ name: "antennas" })}
          >
            <Icon name="antenna" />
            <span>Antennas</span>
          </button>
          <button
            class="tab"
            aria-current={tab === "Settings" ? "page" : undefined}
            onClick={() => go({ name: "settings" })}
          >
            <Icon name="settings" />
            <span>Settings</span>
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
