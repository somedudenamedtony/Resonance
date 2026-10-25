import { render } from "preact";
import { App } from "./App";
import { client, initState } from "./state";
import "./styles.css";

void initState();
client.start();

// iOS suspends sockets in the background; reconnect when the app comes back.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && client.link === "closed") client.start();
});

// Service workers need a secure context (HTTPS or localhost). The bridge serves plain HTTP,
// so on the phone this is skipped and the home-screen app runs from the manifest alone.
if ("serviceWorker" in navigator && window.isSecureContext && import.meta.env.PROD) {
  void navigator.serviceWorker.register("./sw.js").catch(() => {});
}

render(<App />, document.getElementById("app")!);
