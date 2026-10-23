// Standalone bundle: dist/ + types/ for bundler-less consumers (and a future publish).
// Hosts that bundle — buche — compile the sources through the "source" export condition
// instead; the git tag carries sources only. The demo (index.html, demo/) runs through
// `npm run dev`, which ignores the lib settings below.

import { copyFileSync, readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Styles stay the host's to import (see src/index.ts): ship them as-is.
const copyStyles: Plugin = {
  name: "copy-styles",
  apply: "build",
  closeBundle() {
    for (const name of ["style.css", "prompt.css"]) {
      copyFileSync(new URL(`./src/${name}`, import.meta.url), new URL(`./dist/${name}`, import.meta.url));
    }
  },
};

export default defineConfig({
  plugins: [copyStyles],
  define: { __CARREAU_VERSION__: JSON.stringify(pkg.version) },
  build: {
    target: "es2022",
    sourcemap: true, // a UI backbone: consumers (e.g. buche) want real stack traces
    lib: {
      // "prompt-view" is optional (it registers the prompt renderer): its own entry.
      entry: { index: "src/index.ts", "prompt-view": "src/prompt-view.ts" },
      formats: ["es"],
    },
    rollupOptions: { output: { entryFileNames: "[name].js", chunkFileNames: "chunks/[name].js" } },
  },
});
