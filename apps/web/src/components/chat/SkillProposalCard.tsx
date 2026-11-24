import type { SkillProposalItem, SkillStorageTarget } from "@pa/contracts/skill-proposal";
import { useState } from "react";
import { actOnSkillProposal } from "../../api/team.ts";

const SCOPE_LABELS: Record<SkillStorageTarget, string> = {
	workspace: "工作区 (.agents/skills)",
	personal: "个人 Skill",
	org: "组织共享",
	global: "全局共享",
};

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
										{hasWorkspace && <option value="workspace">工作区 (.agents/skills)</option>}
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
						<details className="settings-details">
							<summary>
								查看 SKILL.md{proposal.scripts?.length ? ` 与 ${proposal.scripts.length} 个脚本` : ""}
							</summary>
							<pre className="pa-viz-code">
								<code>{proposal.body}</code>
							</pre>
							{proposal.scripts?.map((script) => (
								<div key={script.path} style={{ marginTop: 8 }}>
									<div style={{ fontSize: 12, fontWeight: 600 }}>
										<code>{script.path}</code>
										{script.executable ? " (executable)" : ""}
									</div>
									<pre className="pa-viz-code">
										<code>{script.content}</code>
									</pre>
								</div>
							))}
						</details>
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
									<span className="pill rsi-status-candidate">默认步骤 3 · 执行前确认</span>
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
		</div>
	);
}
