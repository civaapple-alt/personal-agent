import { PiRpcWorker } from "../index.ts";

async function main(): Promise<void> {
	const worker = new PiRpcWorker({
		cwd: process.cwd(),
		provider: "kimi-coding",
		model: "kimi-for-coding",
		noSession: true,
		onDialog: async (request) => {
			console.log(`[dialog:${request.method}] ${request.title}`);
			if (request.method === "confirm") {
				return { confirmed: false };
			}
			return { cancelled: true };
		},
	});

	worker.onNotice((notice) => {
		console.log(`[notice:${notice.method}]`, JSON.stringify(notice));
	});

	console.log("Starting Pi RPC worker (kimi-coding / kimi-for-coding)...");
	await worker.start();

	try {
		const state = await worker.getState();
		console.log("Connected state:", {
			provider: state.model?.provider,
			model: state.model?.id,
			thinkingLevel: state.thinkingLevel,
			sessionId: state.sessionId,
		});

		const result = await worker.runPromptAndWait(
			"Read docs/concepts/architecture-and-plan.md and reply in two short Chinese sentences explaining what the workbench and Pi Worker each do.",
			{
				timeoutMs: 90_000,
				onTextDelta: (delta) => process.stdout.write(delta),
			},
		);

		console.log("\n--- Settled Summary ---");
		console.log({
			disposition: result.disposition,
			aborted: result.aborted,
			toolsUsed: result.toolExecutions.map((t) => t.toolName),
			noticesCount: result.notices.length,
			dialogsCount: result.dialogs.length,
			assistantTextLength: result.assistantText.length,
		});
	} finally {
		await worker.stop();
		console.log("Worker stopped cleanly.");
	}
}

main().catch((error) => {
	console.error("Smoke test failed:", error);
	process.exitCode = 1;
});
