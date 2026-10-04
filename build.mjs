import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist/public", { recursive: true });
await build({
  entryPoints: ["web/main.tsx"],
  bundle: true,
  minify: true,
  outfile: "dist/public/app.js",
  target: ["es2022"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
await copyFile("web/index.html", "dist/public/index.html");
await copyFile("web/favicon.svg", "dist/public/favicon.svg");
