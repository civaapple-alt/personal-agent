import {
	buildSharedWorkerPiArgs,
	buildSharedWorkerTools,
	runSharedPiRpcWorker,
	type SharedPiWorkerRequest,
} from "../shared/local-rpc-worker.ts";
import type { BoardRole, LocalWorkerRequest, LocalWorkerResult } from "./types.ts";

const BOARD_EXTENSION_TOOLS = ["post_to_board", "read_board_post"];

function toSharedRequest(req: LocalWorkerRequest): SharedPiWorkerRequest {
	return {
		cwd: req.cwd,
		readOnly: req.boardRole === "verifier" || req.readOnly,
		sessionFile: req.sessionFile,
		prompt: req.prompt,
		extraTools: BOARD_EXTENSION_TOOLS,
		extensionEntries: req.extensionEntryPath ? [req.extensionEntryPath] : [],
		modelOverride: req.modelOverride,
		env: req.env,
	};
}

export function buildWorkerTools(boardRole: BoardRole, readOnly: boolean): string[] {
	return buildSharedWorkerTools(boardRole === "verifier" || readOnly, BOARD_EXTENSION_TOOLS);
}

export function buildWorkerPiArgs(req: LocalWorkerRequest): string[] {
	return buildSharedWorkerPiArgs(toSharedRequest(req));
}

export async function runLocalPiRpcWorker(req: LocalWorkerRequest, signal?: AbortSignal): Promise<LocalWorkerResult> {
	return runSharedPiRpcWorker(toSharedRequest(req), signal);
}
