import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

const rootDir = process.cwd();
const outDir = resolve(rootDir, "web/dist");
const assetsDir = resolve(outDir, "assets");

mkdirSync(assetsDir, { recursive: true });

await build({
	entryPoints: [resolve(rootDir, "web/src/main.tsx")],
	bundle: true,
	format: "esm",
	jsx: "automatic",
	target: ["es2024"],
	sourcemap: true,
	minify: process.env.NODE_ENV === "production",
	outfile: resolve(assetsDir, "app.js"),
	loader: {
		".css": "css",
	},
});

copyFileSync(resolve(rootDir, "web/index.html"), resolve(outDir, "index.html"));
console.log("Built V4 web UI into web/dist");
