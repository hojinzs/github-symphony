import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

const clientRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: clientRoot,
  plugins: [tailwindcss(), TanStackRouterVite(), react()],
  build: {
    outDir: "dist",
  },
  server: {
    proxy: {
      "/api": "http://localhost:4680",
      "/healthz": "http://localhost:4680",
    },
  },
  resolve: {
    alias: {
      "@": resolve(clientRoot, "src"),
    },
  },
});
