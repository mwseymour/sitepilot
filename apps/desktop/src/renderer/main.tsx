import { createSitePilotDesktopApi } from "@sitepilot/contracts";
import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./app.js";
import { installButtonLoadingIndicators } from "./button-loading.js";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Renderer root container not found.");
}

// In a browser (the hosted app) there's no Electron preload: the same API
// goes to the SitePilot server instead.
if (!window.sitePilotDesktop) {
  window.sitePilotHosted = true;
  window.sitePilotDesktop = createSitePilotDesktopApi(async (channel, request) => {
    const response = await fetch(`/api/ipc/${encodeURIComponent(channel)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    if (response.status === 401) {
      window.location.href = "/";
      throw new Error("Signed out. Sign in again with WordPress.");
    }
    return response.json();
  });
}

installButtonLoadingIndicators();

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
