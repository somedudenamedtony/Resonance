import { render } from "preact";
import { App } from "./App";
import { client } from "./state";
import "./styles.css";

client.start();

// iOS suspends sockets in the background; reconnect when the app comes back.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && client.link === "closed") client.start();
});

render(<App />, document.getElementById("app")!);
