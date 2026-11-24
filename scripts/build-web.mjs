import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

const rootDir = process.cwd();
const outDir = resolve(rootDir, "apps/web/dist");
const assetsDir = resolve(outDir, "assets");

mkdirSync(assetsDir, { recursive: true });

await build({
	entryPoints: [resolve(rootDir, "apps/web/src/main.tsx")],
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

copyFileSync(resolve(rootDir, "apps/web/index.html"), resolve(outDir, "index.html"));
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) copyFileSync(resolve(rootDir, name), resolve(outDir, name));
console.log("Built Personal Agent web UI into apps/web/dist");
