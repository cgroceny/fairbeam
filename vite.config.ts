import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { visualizer } from "rollup-plugin-visualizer";

// `--mode demo`: the read-only public demo, served under /app/ next to the landing page.
// FAIRBEAM_REPORT=1 writes a bundle treemap (dist*/stats.html, raw/json in stats.json): npm run build:report
export default defineConfig(({ mode }) => ({
  base: mode === "demo" ? "/app/" : "/",
  plugins: [
    solid(),
    ...(process.env.FAIRBEAM_REPORT
      ? [visualizer({ filename: `${mode === "demo" ? "dist-demo" : "dist"}/stats.${process.env.FAIRBEAM_REPORT === "json" ? "json" : "html"}`, template: process.env.FAIRBEAM_REPORT === "json" ? "raw-data" : "treemap", gzipSize: true })]
      : []),
  ],
  clearScreen: false,
  // Prebundle lazy workspace/editor dependencies before first use. Vite discovering one on
  // demand reloads the page; splitting CodeMirror imports across optimizer generations can also
  // make an extension from one copy incompatible with an EditorState from another.
  optimizeDeps: { include: ["three", "three/addons/controls/OrbitControls.js",
    "three/addons/environments/RoomEnvironment.js", "three/addons/renderers/CSS2DRenderer.js", "fflate",
    "@codemirror/state", "@codemirror/view", "@codemirror/commands", "@codemirror/lang-python",
    "@codemirror/language", "@codemirror/search", "@codemirror/lint", "@lezer/highlight"] },
  server: {
    port: 5310,
    strictPort: true,
    watch: { ignored: ["**/.sim/**", "**/python/**"] },
    // local run server (`fairbeam serve`); target from FAIRBEAM_API, default port 5320
    proxy: { "/api": { target: process.env.FAIRBEAM_API ?? "http://127.0.0.1:5320", changeOrigin: false } },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // three.js (the bulk of the initial download) in its own long-lived chunk
        manualChunks: (id) => (/node_modules\/three\//.test(id) ? "three" : /node_modules\/(solid-js|lucide-solid)\//.test(id) ? "vendor" : undefined),
      },
    },
  },
}));
