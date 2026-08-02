// Blueprint: docs/system-analysis/17-technical-blueprint.md §8.2 -- "the sidebar/menu is
// derived from the route table filtered by the session's permission set -- never
// hand-maintained." Phase 1: the nav is the full, hard-coded route list (no session/permission
// data exists yet); replace with a derivation over `router.tsx`'s route `handle`s once
// `identity`/`access` expose the caller's permission set to the client.
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router";

import { applyDocumentDirection, SUPPORTED_LOCALES, type SupportedLocale } from "../lib/i18n.js";

const NAV_ITEMS = [
  { to: "/", labelKey: "app.name", end: true },
  { to: "/counter", labelKey: "surfaces.counter" },
  { to: "/office", labelKey: "surfaces.backoffice" },
  { to: "/insights", labelKey: "surfaces.insights" },
] as const;

export function Shell(): ReactElement {
  const { t, i18n } = useTranslation();

  function switchLocale(locale: SupportedLocale): void {
    void i18n.changeLanguage(locale);
    applyDocumentDirection(locale);
  }

  return (
    <div className="min-h-svh bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-blue-600 focus:px-3 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <span className="text-lg font-semibold">{t("app.name")}</span>

        <nav aria-label="Primary" className="flex gap-4">
          {NAV_ITEMS.slice(1).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `rounded px-2 py-1 text-sm ${isActive ? "bg-blue-600 text-white" : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"}`
              }
            >
              {t(item.labelKey)}
            </NavLink>
          ))}
        </nav>

        <div className="flex gap-1" role="group" aria-label="Language">
          {SUPPORTED_LOCALES.map((locale) => (
            <button
              key={locale}
              type="button"
              onClick={() => switchLocale(locale)}
              aria-pressed={i18n.language === locale}
              className={`rounded px-2 py-1 text-xs uppercase ${
                i18n.language === locale ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900" : "text-slate-500"
              }`}
            >
              {locale}
            </button>
          ))}
        </div>
      </header>

      <main id="main-content" className="p-4">
        <Outlet />
      </main>
    </div>
  );
}
