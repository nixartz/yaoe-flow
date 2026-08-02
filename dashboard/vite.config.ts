import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      // Em dev, o backend (yaoe-flow) roda na porta separada da
      // dashboard (ver DASHBOARD_PORT no .env). Ajuste se estiver diferente.
      "/api": "http://localhost:4791",
    },
  },
});
