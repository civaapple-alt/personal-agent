import type { PiRpcWorkerOptions } from "../src/rpc/pi-rpc-worker.ts";

export async function reportReady(options: PiRpcWorkerOptions, tools?: string[]): Promise<void> {
	const requested = options.args?.[(options.args?.indexOf("--tools") ?? -1) + 1]?.split(",") ?? [];
	const response = await fetch(`${options.env?.PA_TEAM_BRIDGE_URL}/ready`, {
		method: "POST",
		headers: { Authorization: `Bearer ${options.env?.PA_TEAM_BRIDGE_TOKEN}` },
		body: JSON.stringify(tools ?? requested),
	});
	if (!response.ok) throw new Error(await response.text());
}

export async function invokeTool(
	options: PiRpcWorkerOptions,
	tool: string,
	args: unknown,
	callId = crypto.randomUUID(),
): Promise<unknown> {
	const response = await fetch(`${options.env?.PA_TEAM_BRIDGE_URL}/tool`, {
		method: "POST",
		headers: { Authorization: `Bearer ${options.env?.PA_TEAM_BRIDGE_TOKEN}` },
		body: JSON.stringify({ tool, callId, args }),
	});
	const value: unknown = await response.json();
	if (!response.ok) throw new Error(JSON.stringify(value));
	return value;
}
