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

import type {
  GetSiteWorkspaceResponse,
  SiteActivityThread
} from "@sitepilot/contracts";

type OkWorkspace = Extract<GetSiteWorkspaceResponse, { ok: true }>;

export type SiteWorkspaceContextValue = {
  siteId: string;
  data: OkWorkspace | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  /** Recent threads with their latest request state (sidebar and Home). */
  activity: SiteActivityThread[];
  reloadActivity: () => Promise<void>;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
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

  const [activity, setActivity] = useState<SiteActivityThread[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const reloadActivity = useCallback(async () => {
    const res = await window.sitePilotDesktop
      .getSiteActivitySummary({ siteId, limit: 200 })
      .catch(() => null);
    if (res?.ok) setActivity(res.threads);
  }, [siteId]);

  // Keep statuses and approval countdowns fresh without a manual refresh.
  useEffect(() => {
    void reloadActivity();
    const interval = window.setInterval(() => {
      void reloadActivity();
    }, 20_000);
    const onFocus = (): void => {
      void reloadActivity();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("sitepilot:activity-changed", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("sitepilot:activity-changed", onFocus);
    };
  }, [reloadActivity]);

  const value = useMemo(
    (): SiteWorkspaceContextValue => ({
      siteId,
      data,
      error,
      loading,
      reload,
      activity,
      reloadActivity,
      paletteOpen,
      setPaletteOpen
    }),
    [siteId, data, error, loading, reload, activity, reloadActivity, paletteOpen]
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

/** Lets any page ask the sidebar and Home to refresh request statuses. */
export function notifyActivityChanged(): void {
  window.dispatchEvent(new Event("sitepilot:activity-changed"));
}
