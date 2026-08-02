import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { AppProviders } from "./app/providers.js";
import { router } from "./app/router.js";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error('Root element "#root" not found in index.html.');

createRoot(rootEl).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
