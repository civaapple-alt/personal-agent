import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";

const rootDir = process.cwd();
const outDir = resolve(rootDir, "apps/cli/dist");
await mkdir(outDir, { recursive: true });

const require = createRequire(import.meta.url);
const sdkDirectory = dirname(require.resolve("@typesafe-ai/sdk/package.json"));

await build({
	entryPoints: [resolve(rootDir, "apps/cli/src/main.ts")],
	outfile: join(outDir, "main.js"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: ["node22"],
	sourcemap: true,
	packages: "bundle",
});

await copyFile(join(sdkDirectory, "LICENSE"), join(outDir, "typesafe-sdk-LICENSE.txt"));
console.log("Built Personal Agent CLI host into apps/cli/dist/main.js");
