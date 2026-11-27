import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const rootDir = process.cwd();
const outDir = resolve(rootDir, "apps/web/dist");
const assetsDir = resolve(outDir, "assets");
const isProd = process.env.NODE_ENV === "production";

mkdirSync(assetsDir, { recursive: true });
rmSync(resolve(assetsDir, "app.css.map"), { force: true });

const tailwindCliPkg = require.resolve("@tailwindcss/cli/package.json");
const tailwindCliBin = resolve(dirname(tailwindCliPkg), "dist/index.mjs");
const tailwindArgs = [
	tailwindCliBin,
	"-i",
	resolve(rootDir, "apps/web/src/styles/app.css"),
	"-o",
	resolve(assetsDir, "app.css"),
	"--silent",
	...(isProd ? ["--minify"] : []),
];

await Promise.all([
	execFileAsync(process.execPath, tailwindArgs, { cwd: rootDir }),
	build({
		entryPoints: [resolve(rootDir, "apps/web/src/main.tsx")],
		bundle: true,
		format: "esm",
		jsx: "automatic",
		target: ["es2024"],
		sourcemap: true,
		minify: isProd,
		outfile: resolve(assetsDir, "app.js"),
	}),
]);

copyFileSync(resolve(rootDir, "apps/web/index.html"), resolve(outDir, "index.html"));
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) copyFileSync(resolve(rootDir, name), resolve(outDir, name));
console.log("Built Personal Agent web UI into apps/web/dist");
