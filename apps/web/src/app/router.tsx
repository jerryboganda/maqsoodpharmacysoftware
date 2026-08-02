// Blueprint: docs/system-analysis/17-technical-blueprint.md §8.2 Decision D-05 -- "React
// Router 7 in data-router / framework-agnostic mode (createBrowserRouter)... Every route
// declares `handle: { permission: ..., surface: ..., title: ... }`."
//
// TODO: once `identity`/`access` expose the caller's permission set to the client, add a
// route `loader` that checks `handle.permission` against it and redirects/403s -- per §8.2
// this must be the ONLY thing a route-level loader does for permission gating (business data
// loading stays in TanStack Query, §8.3, not in router loaders).
import { createBrowserRouter } from "react-router";

import { HomeRoute } from "./HomeRoute.js";
import { Shell } from "./Shell.js";

export interface RouteHandle {
  readonly permission: string | null;
  readonly surface: "shell" | "counter" | "backoffice" | "insights";
  readonly title: string;
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      {
        index: true,
        element: <HomeRoute />,
        handle: { permission: null, surface: "shell", title: "Home" } satisfies RouteHandle,
      },
      {
        path: "counter",
        lazy: async () => {
          const { CounterHome } = await import("../surfaces/counter/CounterHome.js");
          return { Component: CounterHome };
        },
        handle: { permission: "sale.cash:view", surface: "counter", title: "Counter" } satisfies RouteHandle,
      },
      {
        path: "office",
        lazy: async () => {
          const { BackofficeHome } = await import("../surfaces/backoffice/BackofficeHome.js");
          return { Component: BackofficeHome };
        },
        handle: { permission: "purchase:view", surface: "backoffice", title: "Back office" } satisfies RouteHandle,
      },
      {
        path: "insights",
        lazy: async () => {
          const { InsightsHome } = await import("../surfaces/insights/InsightsHome.js");
          return { Component: InsightsHome };
        },
        handle: { permission: "report.*:view", surface: "insights", title: "Insights" } satisfies RouteHandle,
      },
    ],
  },
]);
