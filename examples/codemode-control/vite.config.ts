import { defineConfig } from "vite";

export default defineConfig({
  root: "app",
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: {
    host: "127.0.0.1",
    port: 5377,
    proxy: {
      "/api": "http://127.0.0.1:8789",
      "/mcp": "http://127.0.0.1:8789",
      "/machinectl": { target: "http://127.0.0.1:8789", ws: true },
      "/health": "http://127.0.0.1:8789",
    },
  },
});
