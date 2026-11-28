import type { SkillProposalItem, SkillStorageTarget } from "@pa/contracts/skill-proposal";
import { useState } from "react";
import { actOnSkillProposal } from "../../api/team.ts";
import { MarkdownView } from "../../MarkdownView.tsx";
import { Badge, Banner, Button, Card, ModalDialog, Select, Tabs } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";

const SCOPE_LABELS: Record<SkillStorageTarget, string> = {
	workspace: "工作区专属",
	personal: "个人 Skill",
	org: "组织共享",
	global: "全局共享",
};

function splitFrontmatter(markdown: string): { frontmatter: string | null; body: string } {
	const match = markdown.match(/^(---\r?\n[\s\S]*?\r?\n---)\r?\n?([\s\S]*)$/u);
	if (!match) return { frontmatter: null, body: markdown };
	return { frontmatter: match[1]!, body: match[2]!.trimStart() };
}

function buildFullSkillMarkdown(proposal: SkillProposalItem): string {
	const { body } = splitFrontmatter(proposal.body.replace(/\r\n/g, "\n").trim());
	return ["---", `name: ${proposal.name}`, `description: ${proposal.description}`, "---", "", body, ""].join("\n");
}

function groupScriptFiles(scripts: NonNullable<SkillProposalItem["scripts"]>) {
	const groups = new Map<string, NonNullable<SkillProposalItem["scripts"]>>();
	for (const script of scripts) {
		const slashIdx = script.path.indexOf("/");
		const group = slashIdx > 0 ? `${script.path.slice(0, slashIdx)}/` : "附加文件";
		const list = groups.get(group) ?? [];
		list.push(script);
		groups.set(group, list);
	}
	return [...groups.entries()].map(([group, items]) => ({ group, items }));
}

interface SkillProposalCardProps {
	matterId: string;
	messageId: string;
	proposals: SkillProposalItem[];
	hasWorkspace: boolean;
	onDone?: () => void;
	onOpenSkillTrust?: () => void;
	onNotice?: (msg: string) => void;
	onError?: (msg: string) => void;
}

/** Interactive human confirmation card for `propose_skill` proposals (`SKILL.md` + `scripts/*`). */
export function SkillProposalCard({
	matterId,
	messageId,
	proposals,
	hasWorkspace,
	onDone,
	onOpenSkillTrust,
	onNotice,
	onError,
}: SkillProposalCardProps) {
	const [busyId, setBusyId] = useState<string | null>(null);
	const [scopeOverrides, setScopeOverrides] = useState<Record<string, SkillStorageTarget>>({});
	const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
	const [previewProposalId, setPreviewProposalId] = useState<string | null>(null);
	const [previewFileTab, setPreviewFileTab] = useState<string>("SKILL.md");
	const [previewMdMode, setPreviewMdMode] = useState<"rendered" | "raw">("rendered");

	const openPreview = (proposal: SkillProposalItem) => {
		setPreviewProposalId(proposal.id);
		setPreviewFileTab("SKILL.md");
		setPreviewMdMode("rendered");
	};

	const previewProposal = previewProposalId ? (proposals.find((p) => p.id === previewProposalId) ?? null) : null;
	const previewFileGroups = previewProposal?.scripts?.length ? groupScriptFiles(previewProposal.scripts) : [];
	const previewActiveFile = previewProposal
		? previewFileTab === "SKILL.md"
			? { path: "SKILL.md", content: buildFullSkillMarkdown(previewProposal), executable: false }
			: (previewProposal.scripts?.find((s) => s.path === previewFileTab) ?? null)
		: null;
	const previewActiveIsMarkdown = Boolean(previewActiveFile && /\.md$/i.test(previewActiveFile.path));
	const previewSplitMd =
		previewActiveFile && previewActiveIsMarkdown ? splitFrontmatter(previewActiveFile.content) : null;

	const handleAction = async (proposal: SkillProposalItem, action: "apply" | "dismiss") => {
		setBusyId(proposal.id);
		setFeedback(null);
		try {
			const storageScope = scopeOverrides[proposal.id] ?? proposal.storageScope;
			const result = await actOnSkillProposal(matterId, messageId, {
				proposalId: proposal.id,
				action,
				storageScope,
			});
			const msg =
				action === "apply"
					? `已沉淀 Skill「${proposal.name}」（写入 ${result.writtenPaths.length} 个文件）`
					: `已忽略 Skill 提案「${proposal.name}」`;
			setFeedback({ kind: "ok", text: msg });
			onNotice?.(msg);
			onDone?.();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			setFeedback({ kind: "err", text: msg });
			onError?.(msg);
		} finally {
			setBusyId(null);
		}
	};

	return (
		<div className="flex flex-col gap-2 mt-2">
			{feedback && <Banner tone={feedback.kind === "err" ? "danger" : "success"}>{feedback.text}</Banner>}
			{proposals.map((proposal) => {
				const selectedScope = scopeOverrides[proposal.id] ?? proposal.storageScope;
				const busy = busyId === proposal.id;
				return (
					<Card key={proposal.id} padding="sm" className="mt-1 flex flex-col gap-2 shadow-sm">
						<div className="flex items-center justify-between gap-2 flex-wrap">
							<div className="flex items-center gap-2 flex-wrap">
								<Badge tone="accent" size="xs">
									Skill 提案
								</Badge>
								<strong className="text-sm font-semibold text-ink">{proposal.name}</strong>
								<span className="text-xs text-ink-secondary">
									{proposal.status === "applied"
										? "已写入磁盘"
										: proposal.status === "dismissed"
											? "已忽略"
											: SCOPE_LABELS[selectedScope]}
								</span>
							</div>
							{proposal.status === "pending" && (
								<div className="flex items-center gap-1.5 flex-wrap">
									<Select
										size="sm"
										className="w-auto"
										value={selectedScope}
										disabled={busy}
										onChange={(e) =>
											setScopeOverrides((prev) => ({
												...prev,
												[proposal.id]: e.target.value as SkillStorageTarget,
											}))
										}
									>
										{hasWorkspace && <option value="workspace">工作区专属</option>}
										<option value="personal">个人 Skill</option>
										<option value="org">组织共享</option>
										<option value="global">全局共享</option>
									</Select>
									<Button
										variant="accent"
										size="xs"
										disabled={busy}
										onClick={() => void handleAction(proposal, "apply")}
									>
										{busy ? "写入中..." : "确认沉淀"}
									</Button>
									<Button
										variant="ghost"
										size="xs"
										disabled={busy}
										onClick={() => void handleAction(proposal, "dismiss")}
									>
										暂不采纳
									</Button>
								</div>
							)}
						</div>
						<p className="m-0 text-sm text-ink leading-normal">{proposal.description}</p>
						<p className="m-0 text-xs text-ink-secondary leading-normal">沉淀原因：{proposal.rationale}</p>
						<div>
							<Button variant="inline" size="xs" onClick={() => openPreview(proposal)}>
								查看 SKILL.md{proposal.scripts?.length ? ` 与 ${proposal.scripts.length} 个脚本` : ""} ↗
							</Button>
						</div>
						{proposal.status === "applied" && (
							<div className="mt-1 text-xs text-ink-secondary flex flex-wrap items-center gap-2">
								{proposal.writtenPaths && proposal.writtenPaths.length > 0 && (
									<span>已写入：{proposal.writtenPaths.join("、")}</span>
								)}
								{proposal.scripts && proposal.scripts.length > 0 && (
									<Badge tone="accent" size="xs">
										已默认信任 · 自主执行
									</Badge>
								)}
								{onOpenSkillTrust && (
									<Button variant="inline" size="xs" onClick={onOpenSkillTrust}>
										管理信任策略 →
									</Button>
								)}
							</div>
						)}
					</Card>
				);
			})}
			<ModalDialog
				open={Boolean(previewProposal)}
				title={previewProposal?.name ?? ""}
				subtitle={
					previewProposal
						? `${SCOPE_LABELS[scopeOverrides[previewProposal.id] ?? previewProposal.storageScope]}${
								previewProposal.scripts?.length ? ` · 含 ${previewProposal.scripts.length} 个脚本` : ""
							}`
						: undefined
				}
				size="lg"
				headerExtra={
					previewProposal ? (
						<Badge tone="accent" size="xs">
							{previewProposal.status === "applied"
								? "已写入磁盘"
								: previewProposal.status === "dismissed"
									? "已忽略"
									: "待确认提案"}
						</Badge>
					) : null
				}
				onClose={() => setPreviewProposalId(null)}
				footer={
					previewProposal ? (
						<Button variant="secondary" size="xs" onClick={() => setPreviewProposalId(null)}>
							关闭
						</Button>
					) : undefined
				}
			>
				{previewProposal && (
					<div className="grid grid-cols-1 md:grid-cols-[204px_minmax(0,1fr)] gap-3.5 items-start min-h-[360px]">
						<aside
							className="flex flex-col gap-2.5 md:pr-3 md:border-r md:border-b-0 border-b border-line pb-2.5 md:pb-0 max-h-[180px] md:max-h-[62vh] overflow-y-auto"
							aria-label="Skill 提案文件"
						>
							<div className="flex flex-col gap-1">
								<span className="text-micro font-semibold text-ink-muted px-1.5 py-0.5">入口定义</span>
								<button
									type="button"
									className={cn(
										"border-0 text-left px-2 py-1.5 rounded-sm text-xs cursor-pointer flex items-center min-w-0 transition-colors",
										previewFileTab === "SKILL.md"
											? "bg-accent-soft text-accent font-semibold"
											: "bg-transparent text-ink-secondary hover:bg-subtle hover:text-ink",
									)}
									onClick={() => setPreviewFileTab("SKILL.md")}
									title="SKILL.md"
								>
									<span className="truncate">SKILL.md</span>
								</button>
							</div>
							{previewFileGroups.map(({ group, items }) => (
								<div key={group} className="flex flex-col gap-1">
									<span className="text-micro font-semibold text-ink-muted px-1.5 py-0.5">
										{group} ({items.length})
									</span>
									{items.map((script) => {
										const displayName = script.path.includes("/")
											? script.path.slice(script.path.indexOf("/") + 1)
											: script.path;
										return (
											<button
												key={script.path}
												type="button"
												className={cn(
													"border-0 text-left px-2 py-1.5 rounded-sm text-xs cursor-pointer flex items-center min-w-0 transition-colors",
													previewFileTab === script.path
														? "bg-accent-soft text-accent font-semibold"
														: "bg-transparent text-ink-secondary hover:bg-subtle hover:text-ink",
												)}
												onClick={() => setPreviewFileTab(script.path)}
												title={script.path}
											>
												<span className="truncate">{displayName}</span>
											</button>
										);
									})}
								</div>
							))}
						</aside>
						<div className="flex flex-col gap-2 min-w-0">
							<div className="flex items-center justify-between gap-2 flex-wrap pb-2 border-b border-line">
								<div className="flex items-center gap-1.5 flex-wrap">
									<code className="text-xs font-mono text-ink bg-subtle px-2 py-0.5 rounded-sm">
										{previewActiveFile?.path ?? previewFileTab}
									</code>
									{previewActiveFile?.executable && (
										<Badge tone="neutral" size="xs">
											executable
										</Badge>
									)}
								</div>
								{previewActiveIsMarkdown && (
									<Tabs
										variant="pill"
										size="sm"
										ariaLabel="查看模式"
										value={previewMdMode}
										onChange={(id) => {
											if (id === "rendered" || id === "raw") setPreviewMdMode(id);
										}}
										items={[
											{ id: "rendered", label: "渲染" },
											{ id: "raw", label: "源码" },
										]}
									/>
								)}
							</div>
							<div className="max-h-[58vh] overflow-y-auto min-w-0">
								{previewActiveIsMarkdown && previewMdMode === "rendered" ? (
									<div className="px-1.5 pt-1 pb-3 text-sm leading-relaxed text-ink">
										{previewSplitMd?.frontmatter && (
											<pre className="m-0 mb-3.5 p-2.5 rounded-md bg-stage border border-line font-mono text-xs leading-relaxed overflow-auto max-h-[58vh] whitespace-pre-wrap break-words">
												<code>{previewSplitMd.frontmatter}</code>
											</pre>
										)}
										<MarkdownView content={previewSplitMd?.body ?? previewActiveFile?.content ?? ""} />
									</div>
								) : (
									<pre className="m-0 p-2.5 rounded-md bg-stage border border-line font-mono text-xs leading-relaxed overflow-auto max-h-[58vh] whitespace-pre-wrap break-words">
										<code>{previewActiveFile?.content ?? ""}</code>
									</pre>
								)}
							</div>
						</div>
					</div>
				)}
			</ModalDialog>
		</div>
	);
}
