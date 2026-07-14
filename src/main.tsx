import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import "./styles/globals.css";

// Surface frontend errors in the dev terminal — the UI webview's console is
// otherwise invisible when debugging native layout issues.
function logNative(msg: string) {
  invoke("log_js", { msg }).catch(() => {});
}
window.addEventListener("error", (e) => logNative(`window.onerror: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => logNative(`unhandledrejection: ${e.reason}`));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
