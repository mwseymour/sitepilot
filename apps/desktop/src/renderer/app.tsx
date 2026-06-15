import { useEffect, useState, type ReactElement } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";

import { HomePage } from "./pages/HomePage.js";
import { AddSitePage } from "./pages/AddSitePage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { ApprovalsPage } from "./pages/site/ApprovalsPage.js";
import { AuditPage } from "./pages/site/AuditPage.js";
import { ConfigPage } from "./pages/site/ConfigPage.js";
import { ChatPage } from "./pages/site/ChatPage.js";
import { DiagnosticsPage } from "./pages/site/DiagnosticsPage.js";
import { OverviewPage } from "./pages/site/OverviewPage.js";
import { SiteSettingsPage } from "./pages/site/SiteSettingsPage.js";
import { SiteWorkspaceLayout } from "./site-workspace/SiteWorkspaceLayout.js";

import "./styles.css";

type ThemeMode = "dark" | "light";

export function App(): ReactElement {
  const [theme, setTheme] = useState<ThemeMode>("dark");

  useEffect(() => {
    const stored = window.localStorage.getItem("sitepilot-theme");
    if (stored === "light" || stored === "dark") {
      setTheme(stored);
      document.documentElement.dataset.theme = stored;
      return;
    }
    document.documentElement.dataset.theme = "dark";
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("sitepilot-theme", theme);
  }, [theme]);

  return (
    <>
      <button
        type="button"
        className="theme-toggle"
        aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
        onClick={() => {
          setTheme((current) => (current === "dark" ? "light" : "dark"));
        }}
      >
        {theme === "dark" ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle
              cx="12"
              cy="12"
              r="3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M12 2.5v2M12 19.5v2M4.5 12h-2M21.5 12h-2M5.3 5.3 3.9 3.9M20.1 20.1l-1.4-1.4M18.7 5.3l1.4-1.4M3.9 20.1l1.4-1.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M20 15.2A8 8 0 0 1 8.8 4a8 8 0 1 0 11.2 11.2Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
        <span>{theme === "dark" ? "Light" : "Dark"}</span>
      </button>
      <HashRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/sites/new" element={<AddSitePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/site/:siteId" element={<SiteWorkspaceLayout />}>
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<OverviewPage />} />
            <Route path="chat" element={<ChatPage />} />
            <Route
              path="conversations"
              element={<ChatPage mode="conversation" />}
            />
            <Route path="config" element={<ConfigPage />} />
            <Route path="approvals" element={<ApprovalsPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="diagnostics" element={<DiagnosticsPage />} />
            <Route path="settings" element={<SiteSettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </HashRouter>
    </>
  );
}
