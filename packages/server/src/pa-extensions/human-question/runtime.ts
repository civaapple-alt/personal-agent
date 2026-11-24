import type { DecisionSource } from "../../orchestrator/human-decision.ts";
import type { MatterRun, WorkerSessionMode } from "../../orchestrator/types.ts";
import type { PromptRunResult } from "../../rpc/pi-rpc-worker.ts";
import type { TeamToolCall } from "../../rpc/team-tool-bridge.ts";
import type { RpcExtensionUIDialogRequest } from "../../rpc/types.ts";
import { resolveBuiltinExtensionPath } from "../builtin-paths.ts";

export const HUMAN_QUESTION_TOOL = "request_clarification";

export function prepareHumanQuestion({
	sessionMode,
	discussionMode,
	isArchitect,
	memberId,
	run,
}: {
	sessionMode: WorkerSessionMode;
	discussionMode: boolean;
	isArchitect: boolean;
	memberId: string;
	run: Pick<MatterRun, "completedClarifications">;
}) {
	const isInternal = sessionMode === "internal";
	const enabled = !isArchitect && !discussionMode && (sessionMode === "lead" || isInternal);
	let clarification: PromptRunResult["clarification"];

	function stage(request: NonNullable<PromptRunResult["clarification"]>) {
		if (clarification) throw new Error("A clarification is already recorded for this execution");
		clarification = request;
	}

	return {
		entry: enabled ? resolveBuiltinExtensionPath("human-question") : null,
		tools: enabled ? [HUMAN_QUESTION_TOOL] : [],
		env: { PA_HUMAN_QUESTION_ENABLED: String(enabled) },
		get clarification() {
			return clarification;
		},
		request({
			question,
			context,
			options,
			sourceAssignmentNumber,
		}: Extract<TeamToolCall, { tool: typeof HUMAN_QUESTION_TOOL }>) {
			if (!enabled) throw new Error("This execution cannot request a decision");
			let source: DecisionSource | undefined;
			if (sourceAssignmentNumber !== undefined) {
				const handoff = run.completedClarifications?.get(sourceAssignmentNumber);
				if (!handoff || handoff.toDelegatorId !== memberId) {
					throw new Error("Use the number of a completed assignment to you that returned a clarification");
				}
				source = handoff.source;
			}
			stage({ question, context, options, source });
			return {
				status: isInternal ? "return_to_delegator" : "staged_for_human",
				note: "The answer is unavailable this turn. Leave the dependent step pending and finish independent work.",
			};
		},
		captureInternalDialog(request: RpcExtensionUIDialogRequest): void {
			if (!isInternal || clarification) return;
			stage({
				question: request.title.trim().slice(0, 1000) || "需要补充委托信息",
				context: request.method === "confirm" ? request.message?.slice(0, 3000) : undefined,
				options: request.method === "select" ? request.options.slice(0, 4) : undefined,
			});
		},
	};
}
