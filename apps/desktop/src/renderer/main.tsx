import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./app.js";
import { installButtonLoadingIndicators } from "./button-loading.js";

const container = document.getElementById("root");

if (!container) {
  throw new Error("Renderer root container not found.");
}

installButtonLoadingIndicators();

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
