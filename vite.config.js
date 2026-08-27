import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base must match the GitHub Pages project subpath
export default defineConfig({
  plugins: [react()],
  base: "/long-put-dashboard/",
});
