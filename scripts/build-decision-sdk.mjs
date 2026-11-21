import { copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const sdkDirectory = dirname(require.resolve("@typesafe-ai/sdk/package.json"));
await build({
	entryPoints: ["src/orchestrator/system-one.ts"],
	outfile: "dist/orchestrator/system-one.js",
	bundle: true,
	platform: "node",
	format: "esm",
	sourcemap: true,
});
await copyFile(join(sdkDirectory, "LICENSE"), "dist/orchestrator/typesafe-sdk-LICENSE.txt");
