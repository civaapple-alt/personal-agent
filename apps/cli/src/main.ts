import { bootHost } from "@pa/server/boot";

async function main(): Promise<void> {
	const booted = await bootHost();
	console.log(`Personal Agent V4 workbench listening on ${booted.localUrl} (bind ${booted.host})`);
	if (booted.lanUrls.length > 0) {
		console.log(`LAN collaboration URLs (invite link required): ${booted.lanUrls.join(", ")}`);
	}

	const stop = async () => {
		console.log("\nShutting down Personal Agent server...");
		await booted.shutdown();
		process.exit(0);
	};

	process.once("SIGINT", () => void stop());
	process.once("SIGTERM", () => void stop());
	if (typeof process.send === "function") {
		process.on("message", (msg) => {
			if (msg === "shutdown") void stop();
		});
	}
}

main().catch((error) => {
	console.error("Failed to start Personal Agent server:", error);
	process.exitCode = 1;
});
