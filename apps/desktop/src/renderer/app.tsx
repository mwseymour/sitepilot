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
        onClick={() => {
          setTheme((current) => (current === "dark" ? "light" : "dark"));
        }}
      >
        {theme === "dark" ? "Light mode" : "Dark mode"}
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
