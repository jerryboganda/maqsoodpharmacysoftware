// Blueprint: docs/system-analysis/17-technical-blueprint.md §8.3 (TanStack Query), §8.10
// (i18n), §8.6 non-negotiable #2 (live region for non-colour status). Every app-wide provider
// lives here, once, so `main.tsx` stays a two-line bootstrap.
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";

import { LiveRegionProvider } from "../a11y/LiveRegionAnnouncer.js";
import i18n from "../lib/i18n.js";
import { queryClient } from "../lib/query-client.js";

export function AppProviders({ children }: { children: ReactNode }): ReactNode {
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <LiveRegionProvider>{children}</LiveRegionProvider>
      </QueryClientProvider>
    </I18nextProvider>
  );
}
