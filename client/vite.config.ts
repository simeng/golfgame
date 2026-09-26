import { defineConfig } from "vite";

// relative base → dist/ works no matter where it's deployed (subpath, file://, any host)
export default defineConfig({
  base: "./",
});
