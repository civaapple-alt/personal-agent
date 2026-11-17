import { useEffect, useRef, useState } from "react";
import { applyMemberAdjustments, chatWithRoleArchitect, type MetaArchitectChatResultDto } from "../../api.ts";
import { formatRoleToolTierLabel } from "../../utils.ts";
import { RoleFindingEvidence } from "./RoleDesignDetails.tsx";

interface TeamHealthcheckModalProps {
	open: boolean;
	memberCount: number;
	matterCount: number;
	onClose: () => void;
	onApplied: () => Promise<void>;
	onOpenArchitectChat?: () => void;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Modal dialog for Team Collaboration Healthcheck: explicit confirmation before invoking LLM, cancellable scan, and selectable adjustments. */
export function TeamHealthcheckPanel({
	open,
	memberCount,
	matterCount,
	onClose,
	onApplied,
	onOpenArchitectChat,
	onNotice,
	onError,
}: TeamHealthcheckModalProps) {
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<MetaArchitectChatResultDto | null>(null);
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [applying, setApplying] = useState(false);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => {
		if (!open) {
			abortRef.current?.abort();
			abortRef.current = null;
			setRunning(false);
			setResult(null);
			setSelectedIds([]);
		}
	}, [open]);

	useEffect(() => {
		setSelectedIds((result?.roleAdjustments ?? []).map((a) => a.memberId));
	}, [result]);

	if (!open) return null;

	const handleStartHealthcheck = async () => {
		if (running) return;
		abortRef.current?.abort();
		const ac = new AbortController();
		abortRef.current = ac;
		setRunning(true);
		setResult(null);
		try {
			const res = await chatWithRoleArchitect(
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
				ac.signal,
			);
			setResult(res);
		} catch (err: unknown) {
			if (!(err instanceof DOMException && err.name === "AbortError")) {
				onError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			setRunning(false);
			abortRef.current = null;
		}
	};

	const handleCancelRun = () => {
		abortRef.current?.abort();
		abortRef.current = null;
		setRunning(false);
	};

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
		<div className="architect-modal-backdrop">
			<button
				type="button"
				className="architect-modal-scrim"
				aria-label="关闭体检弹窗"
				onClick={() => {
					handleCancelRun();
					onClose();
				}}
			/>
			<div className="architect-modal-card" role="dialog" aria-modal="true" aria-label="团队协作体检">
				<div className="banner-row">
					<div className="architect-header-title-wrap">
						<h2 className="ui-card-title architect-modal-title">团队协作体检</h2>
						<span className="pill">只读治理 · 不占用事项列表</span>
					</div>
					<button
						type="button"
						className="btn-inline"
						onClick={() => {
							handleCancelRun();
							onClose();
						}}
					>
						关闭
					</button>
				</div>

				{!running && !result && (
					<div className="architect-form-body">
						<div className="notice-card">
							<strong>确认发起 AI 团队协作体检？</strong>
							<p className="healthcheck-confirm-desc">
								本次将调用大模型（Role Architect）只读扫描当前 <strong>{memberCount}</strong>{" "}
								位业务成员的职责边界与工具权限， 并结合近 <strong>{matterCount}</strong>{" "}
								个事项的运行摩擦信号给出优化建议，通常耗时 10~30 秒，不会擅自修改任何成员或代码。
							</p>
						</div>
						<div className="form-footer">
							<span className="muted-tiny">运行期间可随时中止取消</span>
							<div className="ui-row-actions">
								<button type="button" className="btn-pill-outline" onClick={onClose}>
									取消
								</button>
								<button type="button" className="btn-pill-dark" onClick={() => void handleStartHealthcheck()}>
									开始体检
								</button>
							</div>
						</div>
					</div>
				)}

				{running && (
					<div className="architect-form-body">
						<div className="notice-card">
							<div className="banner-row">
								<strong>正在扫描团队协作健康度…</strong>
								<button type="button" className="btn-pill-outline btn-xs" onClick={handleCancelRun}>
									取消体检
								</button>
							</div>
							<p className="healthcheck-confirm-desc">
								正在核对成员工具最小权限、岗位职责重叠度以及近期委托/异常信号，请稍候。
							</p>
						</div>
					</div>
				)}

				{!running && result && (
					<div className="architect-form-body">
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
											<RoleFindingEvidence finding={finding} />
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
							<div className="actions-row compact">
								{onOpenArchitectChat && (
									<button
										type="button"
										className="btn-inline btn-xs"
										onClick={() => {
											onClose();
											onOpenArchitectChat();
										}}
									>
										转入对话继续讨论 →
									</button>
								)}
								<button type="button" className="btn-inline btn-xs" onClick={() => setResult(null)}>
									重新体检
								</button>
							</div>
							<div className="actions-row compact">
								<button type="button" className="btn-pill-outline btn-xs" onClick={onClose}>
									关闭
								</button>
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
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
