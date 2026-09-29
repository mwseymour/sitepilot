import type { ReactElement } from "react";
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
import { ThreadIndexPage } from "./pages/site/ThreadIndexPage.js";
import { SiteWorkspaceLayout } from "./site-workspace/SiteWorkspaceLayout.js";

import { ThemeProvider } from "./theme/theme.js";

import "./theme/tokens.css";
import "./styles.css";
import "./shell.css";

export function App(): ReactElement {
  return (
    <ThemeProvider>
      <HashRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/sites/new" element={<AddSitePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/site/:siteId" element={<SiteWorkspaceLayout />}>
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<OverviewPage />} />
            <Route path="requests" element={<ThreadIndexPage mode="request" />} />
            <Route
              path="conversations-list"
              element={<ThreadIndexPage mode="conversation" />}
            />
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
    </ThemeProvider>
  );
}
