import type { MatterProgressDto, MemoryCategory, TeamMemberDto } from "../api.ts";

export const STATUS_LABELS: Record<string, string> = {
	open: "推进中",
	waiting_user: "待你确认",
	delivered: "已交付",
	archived: "已归档",
};

export const STAGE_ORDER: MatterProgressDto["stage"][] = ["starting", "thinking", "tool", "waiting_user", "finalizing"];

export const STAGE_LABELS: Record<MatterProgressDto["stage"], string> = {
	starting: "准备中",
	thinking: "思考规划",
	tool: "查看/执行",
	waiting_user: "待你确认",
	finalizing: "整理交付",
};

export const SHORT_STAGE_LABELS: Record<MatterProgressDto["stage"], string> = {
	starting: "准备",
	thinking: "思考",
	tool: "执行",
	waiting_user: "确认",
	finalizing: "整理",
};

export const MEMORY_SCOPE_LABELS: Record<string, string> = {
	role_general: "岗位通用（所有组织与仓库可用）",
	company_private: "组织经验与记忆（同组织跨仓库共享）",
	project_private: "仓库经验与规范（仅当前仓库生效）",
};

export const MEMORY_SCOPE_SHORT_LABELS: Record<string, string> = {
	role_general: "岗位通用",
	company_private: "组织记忆",
	project_private: "仓库记忆",
};

export const MEMORY_CATEGORY_VALUES: MemoryCategory[] = [
	"efficiency",
	"troubleshooting",
	"collaboration",
	"user_correction",
	"domain_constraint",
	"general",
];

export const MEMORY_CATEGORY_LABELS: Record<MemoryCategory, string> = {
	efficiency: "提效方法",
	troubleshooting: "问题排障",
	collaboration: "高效协同",
	user_correction: "用户纠偏",
	domain_constraint: "项目规范",
	general: "通用经验",
};

export const MEMORY_STATUS_LABELS: Record<string, string> = {
	candidate: "待核验",
	verified: "已验证",
	superseded: "已替代",
	rejected: "已忽略",
};

export const FEEDBACK_RATING_LABELS: Record<string, string> = {
	positive: "认可采纳",
	neutral: "一般 / 补充说明",
	negative: "需修订 / 未达预期",
};

export const DELIVERABLE_TYPE_LABELS: Record<string, string> = {
	document: "文档",
	artifact: "文件产物",
	prototype_image: "原型图",
	service_url: "在线服务",
};

export const BOT_PALETTE = [
	{ bg: "#35b49b", tilt: "0deg" },
	{ bg: "#4e6df5", tilt: "-7deg" },
	{ bg: "#8b5cf6", tilt: "6deg" },
	{ bg: "#ec6a2c", tilt: "-4deg" },
	{ bg: "#0891b2", tilt: "5deg" },
];

export function getBotTheme(index: number): { bg: string; tilt: string } {
	return BOT_PALETTE[index % BOT_PALETTE.length] ?? { bg: "#35b49b", tilt: "0deg" };
}

export function getMemberThemeById(
	members: TeamMemberDto[] | undefined,
	memberId: string | null | undefined,
): { bg: string; tilt: string } {
	if (!members || !memberId) return getBotTheme(0);
	const idx = members.findIndex((m) => m.id === memberId);
	return idx >= 0 ? getBotTheme(idx) : getBotTheme(0);
}

export type RoleMood = MatterProgressDto["stage"] | "idle";

export function inferDelegationMood(stageLabel: string): RoleMood {
	if (/撰写|整理|完成/.test(stageLabel)) return "finalizing";
	if (/确认|等待/.test(stageLabel)) return "waiting_user";
	if (/读取|执行|修改|写入|调用|处理/.test(stageLabel)) return "tool";
	if (/启动|接入/.test(stageLabel)) return "starting";
	return "thinking";
}

export function splitTagsInput(raw: string): string[] {
	return raw
		.split(/[,，、\n]/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function formatClockTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function formatElapsedDuration(totalSeconds: number): string {
	const safe = Math.max(0, Math.round(totalSeconds));
	if (safe < 60) return `${safe}s`;
	const hours = Math.floor(safe / 3600);
	const mins = Math.floor((safe % 3600) / 60);
	const secs = safe % 60;
	if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	return `${mins}m ${secs}s`;
}

/** Strips inline Markdown markers, headings, and list prefixes for crisp plain-text previews. */
export function stripMarkdownFormatting(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/```[^\n]*\n?/g, "")
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/^\s{0,3}(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+)/gm, "")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/\*([^*\n]+)\*/g, "$1")
		.replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?，。；！？])/g, "$1$2")
		.replace(/[ \t]*\n+[ \t]*/g, " ")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

export function formatByteSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Formats declared RoleTemplate tool lists into concise 4-tier permission badges. */
export function formatRoleToolTierLabel(tools: string[] | undefined): string {
	if (!tools || tools.length === 0) return "纯文稿";
	if (tools.includes("edit") || tools.includes("write")) return "可改代码";
	if (tools.includes("bash")) return "含命令";
	return "只读";
}
