import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // The router plugin must run before the React plugin so generated routes are
  // transformed with automatic code splitting enabled.
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
});
