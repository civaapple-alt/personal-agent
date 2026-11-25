import { tmpdir } from "node:os";
import type { PiNativeSkillDto } from "@pa/contracts/skill-trust";
import { PiRpcWorker } from "./pi-rpc-worker.ts";

/** Query Pi natively via RPC `get_commands` for all Skills discovered by Pi itself (zero model calls, zero host FS scanning). */
export async function readPiDiscoveredSkills(options?: {
	cwd?: string;
	inheritLocalPiResources?: boolean;
	commandTimeoutMs?: number;
}): Promise<PiNativeSkillDto[]> {
	const inheritLocal = options?.inheritLocalPiResources !== false;
	const worker = new PiRpcWorker({
		cwd: options?.cwd ?? tmpdir(),
		noSession: true,
		commandTimeoutMs: options?.commandTimeoutMs ?? 5_000,
		args: [
			"--offline",
			"--no-approve",
			"--no-tools",
			"--no-context-files",
			...(inheritLocal ? [] : ["--no-extensions"]),
		],
	});
	try {
		await worker.start();
		const commands = await worker.getCommands();
		return commands
			.filter((cmd) => cmd.source === "skill")
			.map((cmd) => ({
				name: cmd.name.startsWith("skill:") ? cmd.name.slice("skill:".length) : cmd.name,
				description: cmd.description?.trim() ?? "",
				source: cmd.sourceInfo?.source ?? "local",
				scope: cmd.sourceInfo?.scope ?? "user",
				origin: cmd.sourceInfo?.origin ?? "top-level",
				filePath: cmd.sourceInfo?.path ?? null,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	} finally {
		await worker.stop();
	}
}
