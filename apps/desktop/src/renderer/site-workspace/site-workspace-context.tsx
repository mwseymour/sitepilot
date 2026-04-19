import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode
} from "react";

import type { GetSiteWorkspaceResponse } from "@sitepilot/contracts";

type OkWorkspace = Extract<GetSiteWorkspaceResponse, { ok: true }>;

export type SiteWorkspaceContextValue = {
  siteId: string;
  data: OkWorkspace | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
};

const SiteWorkspaceContext = createContext<SiteWorkspaceContextValue | null>(
  null
);

export function SiteWorkspaceProvider({
  siteId,
  children
}: {
  siteId: string;
  children: ReactNode;
}): ReactElement {
  const [data, setData] = useState<OkWorkspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await window.sitePilotDesktop.getSiteWorkspace({ siteId });
    if (!res.ok) {
      setError(res.message);
      setData(null);
    } else {
      setData(res);
    }
    setLoading(false);
  }, [siteId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo(
    (): SiteWorkspaceContextValue => ({
      siteId,
      data,
      error,
      loading,
      reload
    }),
    [siteId, data, error, loading, reload]
  );

  return (
    <SiteWorkspaceContext.Provider value={value}>
      {children}
    </SiteWorkspaceContext.Provider>
  );
}

export function useSiteWorkspace(): SiteWorkspaceContextValue {
  const ctx = useContext(SiteWorkspaceContext);
  if (!ctx) {
    throw new Error(
      "useSiteWorkspace must be used within SiteWorkspaceProvider"
    );
  }
  return ctx;
}
