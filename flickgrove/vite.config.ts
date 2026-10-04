import { fileURLToPath, URL } from "node:url";
import { resolve } from "node:path";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwind from "@tailwindcss/vite";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
let outputDirectory = resolve("dist");
export default defineConfig({
  resolve: {
    alias: { $lib: fileURLToPath(new URL("./src/lib", import.meta.url)) },
  },
  plugins: [
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      emitTsDeclarations: true,
      strategy: ["baseLocale"],
    }),
    svelte(),
    tailwind(),
    {
      name: "offline-shell",
      configResolved(config) {
        outputDirectory = resolve(config.root, config.build.outDir);
      },
      closeBundle() {
        const assets = readdirSync(resolve(outputDirectory, "assets")).map(
          (file) => `/assets/${file}`,
        );
        const version = createHash("sha256")
          .update(assets.join("\n"))
          .digest("hex")
          .slice(0, 12);
        const source = readFileSync("public/sw.js", "utf8")
          .replace("flickgrove-v1", `flickgrove-${version}`)
          .replace("/* BUILD_ASSETS */ []", JSON.stringify(assets));
        writeFileSync(resolve(outputDirectory, "sw.js"), source);
      },
    },
  ],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4318",
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          proxy.on("proxyReqWs", (req) =>
            req.setHeader("Origin", "http://127.0.0.1:4318"),
          );
          proxy.on("proxyReq", (req) =>
            req.setHeader("Origin", "http://127.0.0.1:4318"),
          );
        },
      },
    },
  },
});
