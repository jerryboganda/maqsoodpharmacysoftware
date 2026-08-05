// Blueprint: docs/system-analysis/17-technical-blueprint.md §8.1 Decision D-04 (Vite 6+ with
// the React plugin), §8.6 (Tailwind CSS 4).
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Talks to apps/api in dev without needing CORS on every request path.
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
