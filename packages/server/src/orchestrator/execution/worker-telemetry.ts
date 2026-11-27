import { classifyGithubFetches } from "../../../../../pa-extensions/worker-runtime/pi/web-fetch-evidence.js";
import type { PersonalAgentStore } from "../../storage/repositories.ts";
import type { TeamMember, WorkspaceLink } from "../../storage/types.ts";
import {
	type DispatchProgressEvent,
	formatToolAction,
	type MatterRun,
	pushRunLog,
	type RpcWorkerLike,
	summarizeToolArgs,
	type WorkerSessionMode,
} from "../types.ts";
import type { BoardWorkerContext } from "./worker-setup.ts";

export interface WorkerTelemetryContext {
	worker: RpcWorkerLike;
	store: PersonalAgentStore;
	matterId: string;
	member: TeamMember;
	workspace: WorkspaceLink | null;
	cwd: string;
	activeOrgId: string | null;
	run: MatterRun;
	sessionMode: WorkerSessionMode;
	boardCtx?: BoardWorkerContext;
	onProgress?: (progress: DispatchProgressEvent) => void;
	activity?: {
		toolStarted: (toolCallId: string, label: string) => void;
		toolFinished: (toolCallId: string, label: string) => void;
		pulse: (label?: string) => void;
	};
}

function buildCompactToolArgs(toolName: string, rawArgs: Record<string, unknown>): Record<string, unknown> {
	return {
		...(toolName === "load_available_skill" && typeof rawArgs.name === "string"
			? { name: rawArgs.name.slice(0, 128) }
			: {}),
		...(toolName === "load_available_skill" && typeof rawArgs.resource === "string"
			? { resource: rawArgs.resource.slice(0, 240) }
			: {}),
		...(typeof rawArgs.path === "string" ? { path: rawArgs.path.slice(0, 240) } : {}),
		...(toolName === "read" && typeof rawArgs.path === "string" && /(?:^|[\\/])SKILL\.md$/i.test(rawArgs.path)
			? {
					skillName: rawArgs.path.replace(/\\/g, "/").split("/").filter(Boolean).at(-2)?.slice(0, 128),
				}
			: {}),
		...(typeof rawArgs.sourcePath === "string" ? { sourcePath: rawArgs.sourcePath.slice(0, 240) } : {}),
		...(typeof rawArgs.command === "string"
			? { command: rawArgs.command.replace(/\s+/g, " ").trim().slice(0, 240) }
			: {}),
		...(typeof rawArgs.title === "string" ? { title: rawArgs.title.slice(0, 240) } : {}),
		...(toolName === "visualize"
			? {
					...(typeof rawArgs.type === "string" ? { type: rawArgs.type.slice(0, 32) } : {}),
					...(typeof rawArgs.before === "string" ? { before: rawArgs.before.slice(0, 240) } : {}),
					...(typeof rawArgs.mermaid === "string" ? { mermaid: rawArgs.mermaid.slice(0, 8000) } : {}),
					...(Array.isArray(rawArgs.options) ? { options: rawArgs.options.slice(0, 8) } : {}),
				}
			: {}),
		...(toolName === "propose_skill"
			? {
					...(typeof rawArgs.name === "string" ? { name: rawArgs.name.slice(0, 64) } : {}),
					...(typeof rawArgs.storageScope === "string" ? { storageScope: rawArgs.storageScope.slice(0, 32) } : {}),
					...(typeof rawArgs.description === "string" ? { description: rawArgs.description.slice(0, 240) } : {}),
					...(typeof rawArgs.rationale === "string" ? { rationale: rawArgs.rationale.slice(0, 240) } : {}),
					...(Array.isArray(rawArgs.scripts) ? { scriptCount: rawArgs.scripts.length } : {}),
				}
			: {}),
		...(toolName === "propose_role"
			? {
					...(typeof rawArgs.action === "string" ? { action: rawArgs.action.slice(0, 16) } : {}),
					...(typeof rawArgs.name === "string" ? { name: rawArgs.name.slice(0, 80) } : {}),
					...(typeof rawArgs.memberId === "string" ? { memberId: rawArgs.memberId.slice(0, 120) } : {}),
					...(typeof rawArgs.rationale === "string" ? { rationale: rawArgs.rationale.slice(0, 240) } : {}),
				}
			: {}),
	};
}

/** Attach Pi RPC event & notice telemetry listeners for a worker run and push cleanup callbacks. */
export function attachWorkerTelemetry(ctx: WorkerTelemetryContext, cleanups: Array<() => void>): void {
	const {
		worker,
		store,
		matterId,
		member,
		workspace,
		cwd,
		activeOrgId,
		run,
		sessionMode,
		boardCtx,
		onProgress,
		activity,
	} = ctx;
	const fetchInputs = new Map<string, unknown>();

	const offEvent = worker.onEvent?.((event) => {
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			const toolName = String(event.toolName ?? "tool");
			const toolCallId = String(event.toolCallId);
			if (toolName === "fetch_content" && event.type === "tool_execution_start") {
				fetchInputs.set(toolCallId, event.args);
			}
			if (event.type === "tool_execution_start") activity?.toolStarted(toolCallId, formatToolAction(toolName));
			else activity?.toolFinished(toolCallId, `已返回${formatToolAction(toolName)}`);

			const rawArgs =
				event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : undefined;
			const compactArgs =
				event.type === "tool_execution_start" && rawArgs ? buildCompactToolArgs(toolName, rawArgs) : undefined;

			if (boardCtx) {
				const appendedEvent = store.appendEvent({
					matterId,
					runId: run.userMessageId || "board",
					agentId: boardCtx.agentId,
					eventType: event.type === "tool_execution_start" ? "tool_start" : "tool_end",
					payload: {
						toolCallId,
						toolName,
						...(compactArgs && Object.keys(compactArgs).length > 0 ? { args: compactArgs } : {}),
						...(event.type === "tool_execution_end" && typeof event.isError === "boolean"
							? { isError: event.isError }
							: {}),
					},
				});
				boardCtx.onEventAppended?.(appendedEvent);
			} else {
				store.appendMessage({
					matterId,
					channel: "notice",
					senderType: "system",
					senderId: member.id,
					metadata: {
						workspaceId: workspace?.id ?? null,
						repoPath: cwd,
						orgId: activeOrgId,
						sourceUserMessageId: run.userMessageId,
					},
					content: JSON.stringify({
						type: event.type,
						toolCallId: event.toolCallId,
						toolName,
						...(compactArgs && Object.keys(compactArgs).length > 0 ? { args: compactArgs } : {}),
						...(event.type === "tool_execution_end" && typeof event.isError === "boolean"
							? { isError: event.isError }
							: {}),
					}),
				});
			}

			if (toolName === "fetch_content" && event.type === "tool_execution_end") {
				const inputArgs = fetchInputs.get(toolCallId);
				fetchInputs.delete(toolCallId);
				const result = event.result;
				const content = result && typeof result === "object" && "content" in result ? result.content : undefined;
				const structured =
					result && typeof result === "object" && "structuredContent" in result
						? result.structuredContent
						: undefined;
				for (const evidence of classifyGithubFetches(inputArgs, content, event.isError !== false, structured)) {
					store.appendMessage({
						matterId,
						channel: "notice",
						senderType: "system",
						senderId: member.id,
						metadata: {
							workspaceId: workspace?.id ?? null,
							repoPath: cwd,
							orgId: activeOrgId,
							sourceUserMessageId: run.userMessageId,
						},
						content: JSON.stringify({
							method: "web_fetch_evidence",
							toolCallId,
							source: evidence.source,
							kind: evidence.kind,
							truncated: evidence.truncated,
						}),
					});
					const label =
						evidence.kind === "temporary_clone"
							? "已获取 GitHub 临时副本，跨轮次可能失效"
							: evidence.kind === "github_api"
								? "已获取 GitHub API 视图，未确认本地克隆"
								: "已获取 GitHub 内容，获取方式未确认";
					pushRunLog(run, member.displayName, label);
				}
			}

			const toolSummary = event.type === "tool_execution_start" ? summarizeToolArgs(event.args) : undefined;
			if (event.type === "tool_execution_start" && toolName !== "delegate_to_member") {
				pushRunLog(
					run,
					member.displayName,
					`${formatToolAction(toolName)}${toolSummary ? `：${toolSummary}` : ""}`,
					{ memberId: member.id, toolCallId, toolName },
				);
			}
			if (event.type === "tool_execution_end") {
				const log = run.recentLogs.findLast(
					(entry) => entry.memberId === member.id && entry.toolCallId === toolCallId,
				);
				if (log) {
					log.toolStatus = typeof event.isError === "boolean" ? (event.isError ? "error" : "success") : "unknown";
				}
			}
			if (sessionMode === "lead" && run.activeDelegations.size > 0) {
				return;
			}
			if (event.type === "tool_execution_start") {
				onProgress?.({
					stage: "tool",
					label: `${member.displayName}：${formatToolAction(toolName)}${toolSummary ? `（${toolSummary}）` : ""}`,
					toolName,
					toolSummary,
					recentLogs: [...run.recentLogs],
				});
			} else {
				onProgress?.({
					stage: "thinking",
					label: `${member.displayName}正在分析结果`,
					toolName,
					recentLogs: [...run.recentLogs],
				});
			}
		} else if (event.type === "agent_start") {
			activity?.pulse("开始生成回复");
			if (sessionMode === "lead" && run.activeDelegations.size > 0) {
				return;
			}
			onProgress?.({
				stage: "thinking",
				label: `${member.displayName}正在思考`,
				recentLogs: [...run.recentLogs],
			});
		} else {
			activity?.pulse();
		}
	});
	if (offEvent) cleanups.push(offEvent);

	cleanups.push(
		worker.onNotice((notice) => {
			activity?.pulse();
			store.appendMessage({
				matterId,
				channel: "notice",
				senderType: "system",
				senderId: member.id,
				content: JSON.stringify(notice),
			});
		}),
	);
}
