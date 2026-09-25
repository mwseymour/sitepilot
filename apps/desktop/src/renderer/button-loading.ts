import { useEffect } from "react";

/**
 * App-wide button loading state. The button a user clicked shows an inline
 * spinner (and aria-busy) while the page it belongs to is busy and the
 * button is disabled, so progress is visible where they clicked, not only in
 * the corner activity indicator. Pages report busy state with useAppBusy.
 */
const CLICKED = "data-loading-click";
const LOADING = "data-loading";
const APP_BUSY = "data-app-busy";
// A click that does not start busy work within this window is forgotten.
const SETTLE_MS = 400;

let busyCount = 0;

function isAppBusy(): boolean {
  return document.documentElement.hasAttribute(APP_BUSY);
}

function setLoading(button: HTMLButtonElement, loading: boolean): void {
  if (loading) {
    button.setAttribute(LOADING, "");
    button.setAttribute("aria-busy", "true");
  } else {
    button.removeAttribute(LOADING);
    button.removeAttribute(CLICKED);
    button.removeAttribute("aria-busy");
  }
}

function refresh(): void {
  const busy = isAppBusy();
  document
    .querySelectorAll<HTMLButtonElement>(
      `button[${CLICKED}], button[${LOADING}]`
    )
    .forEach((button) => {
      if (busy && button.disabled && button.hasAttribute(CLICKED)) {
        setLoading(button, true);
      } else if (!busy || !button.disabled) {
        if (button.hasAttribute(LOADING)) setLoading(button, false);
      }
    });
}

/** Report a page's busy state; spinners clear when nothing is busy. */
export function useAppBusy(busy: boolean): void {
  useEffect(() => {
    if (!busy) return undefined;
    busyCount += 1;
    document.documentElement.setAttribute(APP_BUSY, "");
    refresh();
    return () => {
      busyCount = Math.max(0, busyCount - 1);
      if (busyCount === 0) document.documentElement.removeAttribute(APP_BUSY);
      refresh();
    };
  }, [busy]);
}

export function installButtonLoadingIndicators(): void {
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      const button =
        target instanceof Element
          ? (target.closest("button") as HTMLButtonElement | null)
          : null;
      if (!button || button.disabled) return;
      button.setAttribute(CLICKED, "");
      window.setTimeout(() => {
        if (!button.hasAttribute(LOADING)) button.removeAttribute(CLICKED);
      }, SETTLE_MS);
    },
    true
  );

  new MutationObserver(refresh).observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled"]
  });
}
