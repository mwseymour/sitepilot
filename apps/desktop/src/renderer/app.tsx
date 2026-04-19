import type { ReactElement } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";

import { HomePage } from "./pages/HomePage.js";
import { ApprovalsPage } from "./pages/site/ApprovalsPage.js";
import { AuditPage } from "./pages/site/AuditPage.js";
import { ConfigPage } from "./pages/site/ConfigPage.js";
import { ChatPage } from "./pages/site/ChatPage.js";
import { DiagnosticsPage } from "./pages/site/DiagnosticsPage.js";
import { OverviewPage } from "./pages/site/OverviewPage.js";
import { SiteWorkspaceLayout } from "./site-workspace/SiteWorkspaceLayout.js";

import "./styles.css";

export function App(): ReactElement {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/site/:siteId" element={<SiteWorkspaceLayout />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="config" element={<ConfigPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="diagnostics" element={<DiagnosticsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}
