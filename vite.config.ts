import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  // The browse daemon writes its logs into .gstack inside the project, which
  // Vite would otherwise treat as a source change and reload on, resetting the
  // very state a QA pass is trying to inspect.
  server: { port: 5210, watch: { ignored: ["**/.gstack/**"] } },
});
