// Blueprint: docs/system-analysis/17-technical-blueprint.md §9.4 rule E-4 ("announces the
// summary in an aria-live=\"assertive\" region"); §8.6 non-negotiable #2 (no status by colour
// alone -- this is the textual channel). A single, app-wide live region rather than one per
// form, so screen-reader users get one predictable announcement channel across all ~95
// screens (mirrors how the legacy's 2,880 MessageBox strings should have worked, but as
// non-blocking, focus-preserving text instead of a modal).
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

interface LiveRegionContextValue {
  /** `assertive` interrupts (errors); `polite` waits its turn (status updates, §9.4 E-4/E-6). */
  announce: (message: string, politeness?: "polite" | "assertive") => void;
}

const LiveRegionContext = createContext<LiveRegionContextValue | null>(null);

export function LiveRegionProvider({ children }: { children: ReactNode }): ReactNode {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  // Re-announcing the identical string twice in a row is a no-op for most screen readers;
  // a trailing zero-width space forces a change without altering what is read aloud.
  const toggleRef = useRef(false);

  const announce = useCallback((message: string, politeness: "polite" | "assertive" = "polite") => {
    toggleRef.current = !toggleRef.current;
    const padded = toggleRef.current ? message : `${message}​`;
    if (politeness === "assertive") setAssertive(padded);
    else setPolite(padded);
  }, []);

  const value = useMemo(() => ({ announce }), [announce]);

  return (
    <LiveRegionContext.Provider value={value}>
      {children}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {polite}
      </div>
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {assertive}
      </div>
    </LiveRegionContext.Provider>
  );
}

export function useLiveRegion(): LiveRegionContextValue {
  const ctx = useContext(LiveRegionContext);
  if (!ctx) throw new Error("useLiveRegion() must be used within <LiveRegionProvider>.");
  return ctx;
}
