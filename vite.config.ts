import { defineConfig } from "vite-plus";

export default defineConfig({
  // The design docs are hand-written, the route tree is generated, and the
  // source fixtures are captured raw responses; keep the formatter away from all.
  fmt: { ignorePatterns: ["docs/**", "*.md", "**/routeTree.gen.ts", "**/__fixtures__/**"] },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["**/__fixtures__/**"],
  },
  run: {
    cache: true,
  },
});
