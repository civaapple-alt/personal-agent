import { useEffect, useState } from "react";
import { applyMemberAdjustments, chatWithRoleArchitect, type MetaArchitectChatResultDto } from "../../api.ts";
import { formatRoleToolTierLabel } from "../../utils.ts";

interface TeamHealthcheckPanelProps {
	result: MetaArchitectChatResultDto | null;
	running: boolean;
	onClose: () => void;
	onCancel: () => void;
	onApplied: () => Promise<void>;
	onOpenArchitectChat?: () => void;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Runs an in-place read-only team healthcheck right on the Team page without creating a matter thread. */
export function TeamHealthcheckPanel({
	result,
	running,
	onClose,
	onCancel,
	onApplied,
	onOpenArchitectChat,
	onNotice,
	onError,
}: TeamHealthcheckPanelProps) {
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [applying, setApplying] = useState(false);

	useEffect(() => {
		setSelectedIds((result?.roleAdjustments ?? []).map((a) => a.memberId));
	}, [result]);

	if (!running && !result) return null;

	const adjustments = result?.roleAdjustments ?? [];
	const toggleMember = (id: string) => {
		setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
	};

	const handleApplySelected = async () => {
		const chosen = adjustments.filter((adj) => selectedIds.includes(adj.memberId));
		if (chosen.length === 0 || applying) return;
		setApplying(true);
		try {
			const res = await applyMemberAdjustments(
				chosen.map((adj) => ({
					memberId: adj.memberId,
					...(adj.suggestedTools ? { tools: adj.suggestedTools } : {}),
					...(adj.addAntiJobs?.length ? { addAntiJobs: adj.addAntiJobs } : {}),
					...(adj.workflowNote ? { workflowNote: adj.workflowNote } : {}),
				})),
			);
			onNotice(`已按体检建议更新 ${res.members.map((m) => `「${m.displayName}」`).join("、")}`);
			await onApplied();
			onClose();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setApplying(false);
		}
	};

	return (
		<div className="ui-card healthcheck-panel">
			<div className="banner-row">
				<strong>团队协作体检报告（仅治理视图，不占用事项列表）</strong>
				<div className="actions-row compact">
					{running ? (
						<button type="button" className="btn-pill-outline btn-xs" onClick={onCancel}>
							停止体检
						</button>
					) : (
						<button type="button" className="btn-inline btn-xs" onClick={onClose}>
							收起
						</button>
					)}
				</div>
			</div>

			{running && !result && (
				<p className="muted-hint compact">正在扫描当前团队职责分工、工具权限边界与近期协作摩擦信号…</p>
			)}

			{result && (
				<>
					{result.reply && <p className="healthcheck-summary">{result.reply}</p>}

					{result.healthFindings && result.healthFindings.length > 0 && (
						<div className="meta-health-grid">
							{result.healthFindings.map((finding, idx) => (
								<div key={`${finding.title}-${idx}`} className={`meta-health-item ${finding.status}`}>
									<span className={`meta-health-badge ${finding.status}`}>
										{finding.status === "ok" ? "✓ 正常" : "! 需注意"}
									</span>
									<div className="meta-health-copy">
										<strong>{finding.title}</strong>
										<span>{finding.detail}</span>
									</div>
								</div>
							))}
						</div>
					)}

					{adjustments.length > 0 && (
						<div className="meta-adjust-list">
							{adjustments.map((adj) => {
								const checked = selectedIds.includes(adj.memberId);
								return (
									<label key={adj.memberId} className={`meta-adjust-card ${checked ? "selected" : ""}`}>
										<div className="meta-adjust-top">
											<span className="meta-adjust-check">
												<input
													type="checkbox"
													checked={checked}
													onChange={() => toggleMember(adj.memberId)}
												/>
												<strong>{adj.memberName}</strong>
											</span>
											<span className="meta-diff-pill">
												{formatRoleToolTierLabel(adj.currentTools)} →{" "}
												{adj.suggestedTools
													? formatRoleToolTierLabel(adj.suggestedTools)
													: formatRoleToolTierLabel(adj.currentTools)}
											</span>
										</div>
										{adj.rationale && <span className="muted-hint compact">{adj.rationale}</span>}
										{adj.addAntiJobs && adj.addAntiJobs.length > 0 && (
											<span className="muted-hint compact">补充边界：{adj.addAntiJobs.join("；")}</span>
										)}
										{adj.workflowNote && (
											<span className="muted-hint compact">流程约定：{adj.workflowNote}</span>
										)}
									</label>
								);
							})}
						</div>
					)}

					<div className="role-proposal-footer">
						{onOpenArchitectChat && (
							<button type="button" className="btn-inline btn-xs" onClick={onOpenArchitectChat}>
								转入角色架构师对话继续讨论 →
							</button>
						)}
						{adjustments.length > 0 && (
							<button
								type="button"
								className="btn-pill-dark btn-xs"
								disabled={selectedIds.length === 0 || applying}
								onClick={() => void handleApplySelected()}
							>
								{applying ? "应用中…" : "确认执行所选调整"}
							</button>
						)}
					</div>
				</>
			)}
		</div>
	);
}

/** Triggers the read-only Team Healthcheck endpoint with an explicit AbortController handle. */
export async function triggerTeamHealthcheck(signal: AbortSignal): Promise<MetaArchitectChatResultDto> {
	return chatWithRoleArchitect(
		{
			messages: [
				{
					role: "user",
					content:
						"请对当前团队做一次协作体检：检查现有成员分工是否重叠、工具权限是否过宽、近期运行摩擦有哪些，并给出可直接勾选执行的权限收窄或边界补充建议。",
				},
			],
			includeHealthcheck: true,
		},
		signal,
	);
}
