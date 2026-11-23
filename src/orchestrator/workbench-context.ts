import { isGuideTopic, readWorkbenchGuide, type WorkbenchTopic } from "../pa-extensions/workbench-help/catalog.ts";
import type { RoleTemplate } from "../roles/types.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { Matter, MatterMessage, TeamMember } from "../storage/types.ts";
import { isCurrentHumanDecision, readHumanDecision } from "./human-decision.ts";
import { scopedSpaceDocumentIds, selectMatterContext, type WorkspaceContext } from "./matter-context.ts";
import { buildTeamCapabilities } from "./team-capabilities.ts";

export interface WorkbenchContext extends WorkspaceContext {
	matter: Matter;
	members: TeamMember[];
	workspaceName?: string;
	runtimeMemberId?: string;
	activeTools?: string[];
	getTemplate?: (member: TeamMember) => RoleTemplate | undefined;
	sourceUserMessageId?: string;
}

const MATTER_STATUS_LABELS = {
	open: "开放",
	waiting_user: "等待用户答复",
	archived: "已归档",
} satisfies Record<Matter["status"], string>;

function plainText(value: string): string {
	return value
		.replace(/\s+/gu, " ")
		.slice(0, 280)
		.replace(/[\\`*_[\]<>]/gu, "\\$&");
}

function readRuntimeTools(message: MatterMessage): string[] | undefined {
	if (message.channel !== "notice" || message.senderType !== "system") return;
	try {
		const event: unknown = JSON.parse(message.content);
		if (
			event &&
			typeof event === "object" &&
			"method" in event &&
			event.method === "runtime_ready" &&
			"tools" in event &&
			Array.isArray(event.tools) &&
			event.tools.every((name): name is string => typeof name === "string")
		)
			return event.tools;
	} catch {
		// Notices may contain plain text.
	}
}

const MANAGED_EXTENSIONS = [
	["read_pa_help", "team-extension"],
	["request_clarification", "human-question"],
	["load_pstack_skill", "pstack-methods"],
	["web_search", "pi-web-access"],
] as const;

function describeTurnToolCalls(store: PersonalAgentStore, context: WorkbenchContext, chinese: boolean): string {
	if (!context.sourceUserMessageId || !context.runtimeMemberId || !context.activeTools) {
		return chinese
			? "当前调用结果未知；历史启动记录不证明当前调用成功。"
			: "Current call results are unknown; a historical startup is not proof of a successful call.";
	}
	const calls = new Map<string, { name: string; outcome: "pending" | "success" | "error" | "unknown" }>();
	for (const message of selectMatterContext({ ...context, messages: store.listMessages(context.matter.id) })
		.messages) {
		if (
			message.channel !== "notice" ||
			message.senderType !== "system" ||
			message.senderId !== context.runtimeMemberId ||
			message.metadata?.sourceUserMessageId !== context.sourceUserMessageId
		)
			continue;
		try {
			const event: unknown = JSON.parse(message.content);
			if (
				!event ||
				typeof event !== "object" ||
				!("type" in event) ||
				!("toolCallId" in event) ||
				typeof event.toolCallId !== "string" ||
				!("toolName" in event) ||
				typeof event.toolName !== "string"
			)
				continue;
			if (!["web_search", "get_search_content", "fetch_content", "load_pstack_skill"].includes(event.toolName))
				continue;
			if (event.type === "tool_execution_start")
				calls.set(event.toolCallId, { name: event.toolName, outcome: "pending" });
			if (event.type === "tool_execution_end" && calls.get(event.toolCallId)?.name === event.toolName) {
				const outcome =
					"isError" in event && typeof event.isError === "boolean"
						? event.isError
							? "error"
							: "success"
						: "unknown";
				calls.set(event.toolCallId, { name: event.toolName, outcome });
			}
		} catch {
			/* Ignore non-JSON notices. */
		}
	}
	return ["web_search", "get_search_content", "fetch_content", "load_pstack_skill"]
		.map((name) => {
			const matching = [...calls.values()].filter((call) => call.name === name);
			const outcome = matching.at(-1)?.outcome;
			const label = chinese
				? outcome === "success"
					? "最近调用结束且未报告工具错误"
					: outcome === "error"
						? "最近调用报告错误"
						: outcome === "pending"
							? "调用尚未结束"
							: outcome === "unknown"
								? "调用已结束但结果状态未知"
								: "本轮未见调用，实际效果未验证"
				: outcome === "success"
					? "latest call ended without a reported tool error"
					: outcome === "error"
						? "latest call reported an error"
						: outcome === "pending"
							? "call still pending"
							: outcome === "unknown"
								? "call ended but its result status is unknown"
								: "no call observed this turn; effectiveness unverified";
			const loaded = context.activeTools?.includes(name)
				? chinese
					? "启动时已加载"
					: "loaded at startup"
				: chinese
					? "启动时未加载"
					: "not loaded at startup";
			return `${name}: ${label} (${loaded})`;
		})
		.join("\n");
}

function describeRuntimeTools(store: PersonalAgentStore, context: WorkbenchContext, chinese: boolean) {
	const { matter, members, runtimeMemberId, activeTools } = context;
	const member = members.find((item) => item.id === (runtimeMemberId ?? matter.leadMemberId));
	let tools = activeTools;
	let lastStartup: MatterMessage | undefined;
	if (!tools && member) {
		const { messages } = selectMatterContext({
			...context,
			messages: store.listMessages(matter.id),
		});
		for (const message of messages.toReversed()) {
			if (message.senderId !== member.id) continue;
			tools = readRuntimeTools(message);
			if (tools) {
				lastStartup = message;
				break;
			}
		}
	}
	const label = member ? plainText(member.displayName) : chinese ? "当前岗位" : "Current role";
	const extensions = MANAGED_EXTENSIONS.filter(([tool]) => tools?.includes(tool)).map(([, extension]) => extension);
	const codeList = (items: readonly string[]) =>
		items.map((item) => `\`${item.replace(/[`\s]/gu, "").slice(0, 280)}\``).join(chinese ? "、" : ", ");
	return {
		source: "runtime_tools",
		heading: chinese ? "岗位工具与扩展" : "Role tools and extensions",
		content: [
			tools
				? chinese
					? `${label}${activeTools ? "本轮启动时" : "最近一次在本工作区启动时"}的工具：${codeList(tools) || "无"}。`
					: `${label} had these tools at ${activeTools ? "this turn’s startup" : "its last startup in this workspace"}: ${codeList(tools) || "none"}.`
				: chinese
					? `${label}在本工作区还没有可用的启动记录。`
					: `No startup record is available for ${label} in this workspace.`,
			extensions.length
				? chinese
					? `从清单识别到的 PA 扩展：${codeList(extensions)}。`
					: `PA-managed extensions identified from the list: ${codeList(extensions)}.`
				: null,
			lastStartup
				? chinese
					? `历史启动记录时间：${lastStartup.createdAt}；该记录仅代表当时的调用模式和配置。`
					: `Historical startup time: ${lastStartup.createdAt}; this record only describes its original call mode and configuration.`
				: null,
			tools
				? chinese
					? `这次启动时 Human Question ${tools.includes("request_clarification") ? "已启用" : "未启用"}。`
					: `Human Question was ${tools.includes("request_clarification") ? "enabled" : "disabled"} at that startup.`
				: null,
			chinese
				? "`human-question` 注册 `request_clarification`。主责用它向人提请决定，协作者用它向直接委托者澄清。旁听、验收和角色架构师不加载此工具。"
				: "`human-question` registers `request_clarification`. Leads can request a human decision and collaborators can ask their delegator. Observers, verifiers, and Role Architect do not load it.",
			chinese
				? "工具已加载只表示启动时注册成功，不证明凭据、网络、供应商或方法调用成功。未调用时应说尚未验证；有 bash 不等于只读，Pi 不是操作系统沙箱。"
				: "Loaded tools only confirm registration at startup, not working credentials, network, provider, or method calls. If not called, say unverified. Bash can write; Pi is not an OS sandbox.",
			describeTurnToolCalls(store, context, chinese),
		]
			.filter(Boolean)
			.join("\n\n"),
	};
}

export async function readWorkbenchTopic(
	store: PersonalAgentStore,
	context: WorkbenchContext,
	topic: WorkbenchTopic,
	chinese: boolean,
) {
	if (isGuideTopic(topic)) return readWorkbenchGuide(topic, chinese);
	if (topic === "runtime_tools") return describeRuntimeTools(store, context, chinese);
	if (topic === "team_capabilities") {
		return {
			source: "team_capabilities",
			heading: chinese ? "当前事项团队能力与证据" : "Team capabilities and evidence",
			content: buildTeamCapabilities({
				...context,
				messages: store.listMessages(context.matter.id),
				getTemplate: context.getTemplate ?? (() => undefined),
			}),
		};
	}

	const { matter, members, workspaceName, activeTools } = context;
	if (topic === "current_matter") {
		const status = chinese ? MATTER_STATUS_LABELS[matter.status] : matter.status;
		const lead = members.find(({ id }) => id === matter.leadMemberId);
		const roster = members.map(({ id, displayName }) => {
			const labels = [
				id === matter.leadMemberId ? (chinese ? "负责人" : "lead") : false,
				id !== matter.leadMemberId && (matter.consultMemberIds == null || matter.consultMemberIds.includes(id))
					? chinese
						? "可请教"
						: "consultable"
					: false,
				matter.observersEnabled && matter.observerMemberIds.includes(id) ? (chinese ? "旁听" : "observer") : false,
			].filter(Boolean);
			return `- ${plainText(displayName)}${labels.length ? ` · ${labels.join(" / ")}` : ""}`;
		});
		return {
			source: "current_matter",
			heading: chinese ? "当前事项" : "Current matter",
			content: [
				chinese
					? `状态：${status}。负责人：${lead ? plainText(lead.displayName) : "未指定或不可见"}。`
					: `Status: ${status}. Lead: ${lead ? plainText(lead.displayName) : "unassigned or not visible"}.`,
				chinese
					? `仓库：${workspaceName ? plainText(workspaceName) : "未绑定"}。AI 旁听：${matter.observersEnabled ? "开启" : "关闭"}。主责默认回应。`
					: `Repository: ${workspaceName ? plainText(workspaceName) : "none"}. AI observers: ${matter.observersEnabled ? "on" : "off"}. The lead responds by default.`,
				chinese
					? `默认资料空间路由：${matter.visibility === "private" ? "发起人的个人空间" : matter.workspaceId ? "当前工作区空间" : "所属组织空间"}；事项关联文档，不为每个事项单独创建 Git 仓库。`
					: `Default space route: ${matter.visibility === "private" ? "creator's personal space" : matter.workspaceId ? "workspace space" : "organization space"}; matters link documents rather than each creating a separate Git repository.`,
				...roster.slice(0, 40),
				...(roster.length > 40
					? [
							chinese
								? `共 ${roster.length} 位可见 AI 成员，此处显示前 40 位。`
								: `${roster.length} visible roles, showing the first 40.`,
						]
					: []),
				...(activeTools
					? [
							`\n${chinese ? "本轮启动时可用工具" : "Tools available at the start of this turn"}: ${activeTools.map(plainText).join(", ")}`,
						]
					: []),
			].join("\n"),
		};
	}

	const { messages } = selectMatterContext({
		...context,
		messages: store.listMessages(matter.id, "user"),
	});
	const scopedIds = scopedSpaceDocumentIds(messages);
	const documents = store.spaces.listDocuments({ matterId: matter.id }).filter((doc) => scopedIds.has(doc.id));
	const heading =
		topic === "pending_decisions"
			? chinese
				? "当前等待答复的决定"
				: "Pending decisions"
			: chinese
				? "当前工作区的空间资料"
				: "Space documents in this workspace";
	const rows =
		topic === "pending_decisions"
			? messages.flatMap((message, index) => {
					const decision = readHumanDecision(message.metadata);
					if (
						decision?.status !== "pending" ||
						!isCurrentHumanDecision(message, decision, matter, messages.slice(index + 1))
					)
						return [];
					const assignee = decision.assignedName
						? plainText(decision.assignedName)
						: chinese
							? "事项管理者"
							: "matter manager";
					return [
						`- ${decision.requests.map(({ question }) => plainText(question)).join(" / ")} · ${chinese ? "等待" : "Waiting for"} ${assignee}`,
					];
				})
			: documents.map((item) => `- ${plainText(item.title)} · rev ${item.revision}`);
	return {
		source: topic,
		heading,
		content: [
			chinese ? `共 ${rows.length} 条。` : `${rows.length} records.`,
			...rows.slice(0, 15),
			...(rows.length > 15 ? [chinese ? "显示前 15 条。" : "Showing the first 15."] : []),
		].join("\n"),
	};
}
