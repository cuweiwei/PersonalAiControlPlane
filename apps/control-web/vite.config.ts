import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({ root: resolve("apps/control-web"), build: { outDir: resolve("dist/control-web"), emptyOutDir: true }, server: { host: "127.0.0.1", port: 9083 } });
