import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The demo page talks to the local signing server (npm run server) on port 8787.
// Vite forwards /api/* there so the browser never needs to know the server's address
// and never holds a key.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
