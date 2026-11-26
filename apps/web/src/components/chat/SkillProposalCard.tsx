import type { SkillProposalItem, SkillStorageTarget } from "@pa/contracts/skill-proposal";
import { useState } from "react";
import { actOnSkillProposal } from "../../api/team.ts";
import { MarkdownView } from "../../MarkdownView.tsx";
import { ModalDialog } from "../../primitives/ModalDialog.tsx";

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
		<div className="skill-proposal-stack">
			{feedback && (
				<output
					style={{
						display: "block",
						fontSize: 12,
						marginTop: 8,
						color: feedback.kind === "err" ? "var(--danger, #b91c1c)" : "var(--success, #15803d)",
					}}
				>
					{feedback.text}
				</output>
			)}
			{proposals.map((proposal) => {
				const selectedScope = scopeOverrides[proposal.id] ?? proposal.storageScope;
				const busy = busyId === proposal.id;
				return (
					<section
						key={proposal.id}
						className="ui-card skill-proposal-card"
						style={{ padding: 14, marginTop: 10 }}
					>
						<div className="pa-viz-card-head" style={{ justifyContent: "space-between" }}>
							<div className="pa-viz-card-head">
								<span className="pa-viz-badge">Skill 提案</span>
								<strong className="pa-viz-title">{proposal.name}</strong>
								<span className="pa-viz-option-desc">
									{proposal.status === "applied"
										? "已写入磁盘"
										: proposal.status === "dismissed"
											? "已忽略"
											: SCOPE_LABELS[selectedScope]}
								</span>
							</div>
							{proposal.status === "pending" && (
								<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
									<select
										className="input-field"
										style={{ width: "auto", padding: "3px 8px", fontSize: 12 }}
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
									</select>
									<button
										type="button"
										className="btn-pill-primary btn-xs"
										disabled={busy}
										onClick={() => void handleAction(proposal, "apply")}
									>
										{busy ? "写入中..." : "确认沉淀"}
									</button>
									<button
										type="button"
										className="btn-pill-ghost btn-xs"
										disabled={busy}
										onClick={() => void handleAction(proposal, "dismiss")}
									>
										暂不采纳
									</button>
								</div>
							)}
						</div>
						<p style={{ margin: "6px 0 4px", fontSize: 13 }}>{proposal.description}</p>
						<p style={{ margin: "0 0 8px", fontSize: 12, opacity: 0.8 }}>沉淀原因：{proposal.rationale}</p>
						<div>
							<button type="button" className="btn-inline" onClick={() => openPreview(proposal)}>
								查看 SKILL.md{proposal.scripts?.length ? ` 与 ${proposal.scripts.length} 个脚本` : ""} ↗
							</button>
						</div>
						{proposal.status === "applied" && (
							<div
								style={{
									marginTop: 8,
									fontSize: 12,
									opacity: 0.9,
									display: "flex",
									flexWrap: "wrap",
									alignItems: "center",
									gap: 8,
								}}
							>
								{proposal.writtenPaths && proposal.writtenPaths.length > 0 && (
									<span>已写入：{proposal.writtenPaths.join("、")}</span>
								)}
								{proposal.scripts && proposal.scripts.length > 0 && (
									<span className="pill rsi-status-verified">已默认信任 · 自主执行</span>
								)}
								{onOpenSkillTrust && (
									<button type="button" className="btn-inline" onClick={onOpenSkillTrust}>
										管理信任策略 →
									</button>
								)}
							</div>
						)}
					</section>
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
						<span className="pa-viz-badge" style={{ whiteSpace: "nowrap", flexShrink: 0 }}>
							{previewProposal.status === "applied"
								? "已写入磁盘"
								: previewProposal.status === "dismissed"
									? "已忽略"
									: "待确认提案"}
						</span>
					) : null
				}
				onClose={() => setPreviewProposalId(null)}
				footer={
					previewProposal ? (
						<button type="button" className="btn-pill-outline btn-xs" onClick={() => setPreviewProposalId(null)}>
							关闭
						</button>
					) : undefined
				}
			>
				{previewProposal && (
					<div className="skills-preview-split">
						<aside className="skills-preview-nav" aria-label="Skill 提案文件">
							<div className="skills-preview-group">
								<span className="skills-preview-group-label">入口定义</span>
								<button
									type="button"
									className={`skills-preview-file-btn ${previewFileTab === "SKILL.md" ? "active" : ""}`}
									onClick={() => setPreviewFileTab("SKILL.md")}
									title="SKILL.md"
								>
									<span>SKILL.md</span>
								</button>
							</div>
							{previewFileGroups.map(({ group, items }) => (
								<div key={group} className="skills-preview-group">
									<span className="skills-preview-group-label">
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
												className={`skills-preview-file-btn ${previewFileTab === script.path ? "active" : ""}`}
												onClick={() => setPreviewFileTab(script.path)}
												title={script.path}
											>
												<span>{displayName}</span>
											</button>
										);
									})}
								</div>
							))}
						</aside>
						<div className="skills-preview-content">
							<div className="skills-preview-filebar">
								<div className="row-wrap-gap">
									<code className="skills-preview-filepath">{previewActiveFile?.path ?? previewFileTab}</code>
									{previewActiveFile?.executable && <span className="pill">executable</span>}
								</div>
								{previewActiveIsMarkdown && (
									<div className="skills-preview-mode-toggle" role="tablist" aria-label="查看模式">
										<button
											type="button"
											role="tab"
											aria-selected={previewMdMode === "rendered"}
											className={`choice-chip ${previewMdMode === "rendered" ? "active" : ""}`}
											onClick={() => setPreviewMdMode("rendered")}
										>
											渲染
										</button>
										<button
											type="button"
											role="tab"
											aria-selected={previewMdMode === "raw"}
											className={`choice-chip ${previewMdMode === "raw" ? "active" : ""}`}
											onClick={() => setPreviewMdMode("raw")}
										>
											源码
										</button>
									</div>
								)}
							</div>
							<div className="skills-preview-viewer">
								{previewActiveIsMarkdown && previewMdMode === "rendered" ? (
									<div className="skills-preview-markdown">
										{previewSplitMd?.frontmatter && (
											<pre className="pa-viz-code skills-modal-code" style={{ marginBottom: 14 }}>
												<code>{previewSplitMd.frontmatter}</code>
											</pre>
										)}
										<MarkdownView content={previewSplitMd?.body ?? previewActiveFile?.content ?? ""} />
									</div>
								) : (
									<pre className="pa-viz-code skills-modal-code">
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
