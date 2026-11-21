import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, Vite proxies to the API and mock provider so the browser sees one origin
// (same as production behind nginx) - cookies stay SameSite=Strict and no CORS is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: false },
      "/mock-whatsapp": { target: "http://localhost:4000", rewrite: (p) => p.replace(/^\/mock-whatsapp/, "") },
    },
  },
});
