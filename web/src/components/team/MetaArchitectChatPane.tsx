import { useEffect, useRef, useState } from "react";
import {
	applyMemberAdjustments,
	chatWithRoleArchitect,
	createMembersBatch,
	type MetaArchitectBlueprintProposalDto,
	type MetaArchitectFormationSuggestionDto,
	type MetaArchitectHealthFindingDto,
	type MetaArchitectMessageDto,
	type MetaArchitectRoleAdjustmentDto,
	type RoleGapSuggestionDto,
	type TeamMemberDto,
} from "../../api.ts";
import { formatRoleToolTierLabel } from "../../utils.ts";

interface MetaArchitectChatPaneProps {
	open: boolean;
	seedGap?: RoleGapSuggestionDto | null;
	memberCount: number;
	matterCount: number;
	matterPrompt?: string;
	workspaceId?: string | null;
	onCreatedBatch: (members: TeamMemberDto[], formation?: MetaArchitectFormationSuggestionDto) => Promise<void> | void;
	onAppliedAdjustments?: () => Promise<void> | void;
	onClose: () => void;
	onSwitchQuickForm: () => void;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

interface ChatTurnItem extends MetaArchitectMessageDto {
	id: string;
	followUpQuestions?: string[];
	healthFindings?: MetaArchitectHealthFindingDto[];
}

const FORMATION_MODE_LABELS: Record<string, string> = {
	solo: "单兵直办（1 AI）",
	lead_consult: "主责 + 指定协同",
	lead_review: "主责 + 定向旁听把关",
	human_first: "人类先讨论定调",
};

/** Conversational Meta-Bot intake, visual healthcheck findings, and actionable role blueprint/adjustment staging. */
export function MetaArchitectChatPane({
	open,
	seedGap,
	memberCount,
	matterCount,
	matterPrompt,
	workspaceId,
	onCreatedBatch,
	onAppliedAdjustments,
	onClose,
	onSwitchQuickForm,
	onNotice,
	onError,
}: MetaArchitectChatPaneProps) {
	const [turns, setTurns] = useState<ChatTurnItem[]>([]);
	const [inputText, setInputText] = useState("");
	const [sending, setSending] = useState(false);
	const [saving, setSaving] = useState(false);
	const [applyingAdjustments, setApplyingAdjustments] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);
	const [proposals, setProposals] = useState<MetaArchitectBlueprintProposalDto[]>([]);
	const [selectedIndexes, setSelectedIndexes] = useState<Set<number>>(new Set());
	const [adjustments, setAdjustments] = useState<MetaArchitectRoleAdjustmentDto[]>([]);
	const [selectedAdjustIds, setSelectedAdjustIds] = useState<Set<string>>(new Set());
	const [formation, setFormation] = useState<MetaArchitectFormationSuggestionDto | undefined>(undefined);
	const abortRef = useRef<AbortController | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		if (!open) {
			abortRef.current?.abort();
			abortRef.current = null;
			return;
		}
		setTurns([]);
		setProposals([]);
		setSelectedIndexes(new Set());
		setAdjustments([]);
		setSelectedAdjustIds(new Set());
		setFormation(undefined);
		setLocalError(null);
		if (seedGap) {
			setInputText(`我想处理的事缺对应角色：${seedGap.reason}\n请评估应该补充 1 个还是多个角色，以及各自不做什么。`);
		} else if (matterPrompt?.trim()) {
			setInputText(`新事项想法：「${matterPrompt.trim().slice(0, 140)}」，帮我看看需要几个人配合，是否缺角色。`);
		} else {
			setInputText("");
		}
	}, [open, seedGap, matterPrompt]);

	const prefillWorkflowTemplate = () => {
		setInputText(
			"我们有这样一个工作流程：\n1. 目标与输入：\n2. 希望拆出几个角色、谁只静默把关：\n3. 人类同事在哪一步拍板：",
		);
		window.setTimeout(() => textareaRef.current?.focus(), 0);
	};

	const sendMessage = async (overrideText?: string, includeHealthcheck = false) => {
		const text = (overrideText ?? inputText).trim();
		if (!text || sending) return;
		setLocalError(null);
		const userTurn: ChatTurnItem = { id: `u_${Date.now()}`, role: "user", content: text };
		const nextTurns = [...turns, userTurn];
		setTurns(nextTurns);
		if (!overrideText) setInputText("");

		const controller = new AbortController();
		abortRef.current = controller;
		setSending(true);
		try {
			const res = await chatWithRoleArchitect(
				{
					messages: nextTurns.map(({ role, content }) => ({ role, content })),
					matterPrompt: matterPrompt?.trim() || undefined,
					workspaceId: workspaceId || null,
					includeHealthcheck,
				},
				controller.signal,
			);
			const assistantTurn: ChatTurnItem = {
				id: `a_${Date.now()}`,
				role: "assistant",
				content: res.reply,
				followUpQuestions: res.followUpQuestions,
				healthFindings: res.healthFindings,
			};
			setTurns([...nextTurns, assistantTurn]);
			if (res.blueprints.length > 0) {
				setProposals(res.blueprints);
				setSelectedIndexes(new Set(res.blueprints.map((_, idx) => idx)));
			}
			if (res.roleAdjustments && res.roleAdjustments.length > 0) {
				setAdjustments(res.roleAdjustments);
				setSelectedAdjustIds(new Set(res.roleAdjustments.map((item) => item.memberId)));
			}
			if (res.recommendedFormation) {
				setFormation(res.recommendedFormation);
			} else if (includeHealthcheck) {
				setFormation(undefined);
			}
		} catch (err: unknown) {
			if (controller.signal.aborted) {
				setLocalError("已停止本次设计对话。");
			} else {
				const msg = err instanceof Error ? err.message : String(err);
				setLocalError(`模型调用失败：${msg}`);
			}
		} finally {
			abortRef.current = null;
			setSending(false);
		}
	};

	const toggleProposal = (idx: number) => {
		setSelectedIndexes((prev) => {
			const next = new Set(prev);
			if (next.has(idx)) next.delete(idx);
			else next.add(idx);
			return next;
		});
	};

	const toggleAdjustment = (memberId: string) => {
		setSelectedAdjustIds((prev) => {
			const next = new Set(prev);
			if (next.has(memberId)) next.delete(memberId);
			else next.add(memberId);
			return next;
		});
	};

	const updateProposalField = (idx: number, field: "name" | "title", value: string) => {
		setProposals((prev) =>
			prev.map((item, i) =>
				i === idx
					? {
							...item,
							draft: {
								...item.draft,
								template: { ...item.draft.template, [field]: value },
							},
						}
					: item,
			),
		);
	};

	const handleConfirmSelected = async () => {
		const chosen = proposals.filter((_, idx) => selectedIndexes.has(idx));
		if (chosen.length === 0 || saving) return;
		setSaving(true);
		try {
			const payload = chosen.map((item) => ({
				name: item.draft.template.name.trim(),
				title: item.draft.template.title.trim(),
				responsibilities: item.draft.template.sections.responsibilitiesAndBoundaries,
				keywords: item.draft.template.keywords,
				skills: item.draft.template.skills,
				tools: item.draft.template.tools,
				antiJobs: item.draft.antiJobs,
				sections: item.draft.template.sections,
				isPrimaryContact: item.draft.template.isPrimaryContact,
			}));
			const res = await createMembersBatch(payload);
			onNotice(`已创建 ${res.members.map((m) => `「${m.displayName}」`).join("、")}`);
			await onCreatedBatch(res.members, formation);
			onClose();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const handleApplyAdjustments = async () => {
		const chosen = adjustments.filter((item) => selectedAdjustIds.has(item.memberId));
		if (chosen.length === 0 || applyingAdjustments) return;
		setApplyingAdjustments(true);
		try {
			const res = await applyMemberAdjustments(
				chosen.map((item) => ({
					memberId: item.memberId,
					...(item.suggestedTools !== undefined ? { tools: item.suggestedTools } : {}),
					...(item.addAntiJobs?.length ? { addAntiJobs: item.addAntiJobs } : {}),
					...(item.workflowNote ? { workflowNote: item.workflowNote } : {}),
				})),
			);
			onNotice(`已应用角色调整：${res.members.map((m) => `「${m.displayName}」`).join("、")}`);
			setAdjustments((prev) => prev.filter((item) => !selectedAdjustIds.has(item.memberId)));
			setSelectedAdjustIds(new Set());
			await onAppliedAdjustments?.();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setApplyingAdjustments(false);
		}
	};

	return (
		<div className="meta-architect-pane">
			{turns.length === 0 ? (
				<div className="meta-entry-grid">
					<button type="button" className="meta-entry-card" onClick={prefillWorkflowTemplate}>
						<span className="meta-entry-icon" aria-hidden="true">
							<svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
								<circle cx="4.5" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.5" />
								<circle cx="15.5" cy="5.5" r="2.2" stroke="currentColor" strokeWidth="1.5" />
								<circle cx="15.5" cy="14.5" r="2.2" stroke="currentColor" strokeWidth="1.5" />
								<path d="M6.7 9.2 13.3 6.2M6.7 10.8 13.3 13.8" stroke="currentColor" strokeWidth="1.5" />
							</svg>
						</span>
						<span className="meta-entry-copy">
							<strong>按工作流配 1~N 个角色</strong>
							<small>填入流程模板再补全，一次拆出互不越界的多角分工</small>
						</span>
					</button>
					<button
						type="button"
						className="meta-entry-card"
						disabled={sending}
						onClick={() =>
							void sendMessage(
								"请对当前团队做一次协作体检：检查现有成员分工是否重叠、工具权限是否过宽，并输出结构化体检卡片与可直接勾选调整的权限/边界提案。",
								true,
							)
						}
					>
						<span className="meta-entry-icon health" aria-hidden="true">
							<svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true">
								<path
									d="M3 10h3.2l2.1-4.8 3.2 9.6 2.1-4.8H17"
									stroke="currentColor"
									strokeWidth="1.6"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						</span>
						<span className="meta-entry-copy">
							<strong>给现有团队做协作体检</strong>
							<small>
								扫描 {memberCount} 位成员与近 {matterCount} 个事项的摩擦及冗余权限
							</small>
						</span>
					</button>
				</div>
			) : (
				<div className="meta-chat-thread" aria-live="polite">
					{turns.map((turn) => (
						<div key={turn.id} className={`meta-turn-bubble ${turn.role}`}>
							<div className="meta-turn-role">{turn.role === "user" ? "我" : "角色设计官"}</div>
							<div className="meta-turn-text">{turn.content}</div>
							{turn.healthFindings && turn.healthFindings.length > 0 && (
								<div className="meta-health-grid">
									{turn.healthFindings.map((finding, idx) => (
										<div key={`${finding.title}_${idx}`} className={`meta-health-item ${finding.status}`}>
											<span className={`meta-health-badge ${finding.status}`}>
												{finding.status === "ok" ? "正常" : "建议调整"}
											</span>
											<div className="meta-health-copy">
												<strong>{finding.title}</strong>
												<span>{finding.detail}</span>
											</div>
										</div>
									))}
								</div>
							)}
							{turn.followUpQuestions && turn.followUpQuestions.length > 0 && (
								<div className="meta-followup-row">
									{turn.followUpQuestions.map((q) => (
										<button
											key={q}
											type="button"
											className="tag-chip architect-chip-btn"
											disabled={sending}
											onClick={() => void sendMessage(q)}
										>
											{q}
										</button>
									))}
								</div>
							)}
						</div>
					))}
					{sending && <div className="meta-turn-loading">正在分析团队职责与边界…</div>}
				</div>
			)}

			{turns.length === 0 && sending && <div className="meta-turn-loading">正在体检现有团队与近期运行记录…</div>}

			{localError && (
				<div className="approval-card meta-error-bar">
					<span>{localError}</span>
					<button type="button" className="btn-inline" onClick={onSwitchQuickForm}>
						切换「快速卡片创建」 →
					</button>
				</div>
			)}

			<div className="meta-composer-row">
				<textarea
					ref={textareaRef}
					rows={turns.length === 0 ? 3 : 2}
					className="composer-input"
					placeholder="写一句需求或流程（点上方卡片可填入模板）"
					value={inputText}
					onChange={(e) => setInputText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void sendMessage();
						}
					}}
				/>
				<div className="meta-composer-actions">
					{sending ? (
						<button type="button" className="btn-pill-outline btn-xs" onClick={() => abortRef.current?.abort()}>
							停止
						</button>
					) : (
						<button
							type="button"
							className="btn-pill-dark btn-xs"
							disabled={!inputText.trim()}
							onClick={() => void sendMessage()}
						>
							发送
						</button>
					)}
				</div>
			</div>

			{adjustments.length > 0 && (
				<div className="meta-proposals-tray">
					<div className="architect-preview-head">
						<strong>
							可应用的现有角色调整（勾选后才实际改写：{selectedAdjustIds.size}/{adjustments.length}）
						</strong>
					</div>
					<div className="meta-adjust-list">
						{adjustments.map((adj) => {
							const checked = selectedAdjustIds.has(adj.memberId);
							const fromLabel = formatRoleToolTierLabel(adj.currentTools);
							const toLabel =
								adj.suggestedTools !== undefined ? formatRoleToolTierLabel(adj.suggestedTools) : null;
							return (
								<label key={adj.memberId} className={`meta-adjust-card ${checked ? "selected" : ""}`}>
									<div className="meta-adjust-top">
										<span className="meta-adjust-check">
											<input
												type="checkbox"
												checked={checked}
												onChange={() => toggleAdjustment(adj.memberId)}
											/>
											<strong>{adj.memberName}</strong>
										</span>
										{toLabel && (
											<span className="meta-diff-pill">
												权限：{fromLabel} ({adj.currentTools.join(", ") || "无"}) →{" "}
												<b>
													{toLabel} ({adj.suggestedTools?.join(", ") || "无"})
												</b>
											</span>
										)}
									</div>
									{adj.addAntiJobs && adj.addAntiJobs.length > 0 && (
										<div className="meta-adjust-tags">
											{adj.addAntiJobs.map((rule) => (
												<span key={rule} className="tag-chip">
													+ 边界：{rule}
												</span>
											))}
										</div>
									)}
									{adj.workflowNote && (
										<div className="meta-adjust-tags">
											<span className="tag-chip skill">+ 流程：{adj.workflowNote}</span>
										</div>
									)}
									{adj.rationale && <div className="meta-blueprint-rationale">{adj.rationale}</div>}
								</label>
							);
						})}
					</div>
					<div className="form-footer">
						<span className="muted-hint">仅修改勾选角色的权限与边界配置，不动历史会话</span>
						<button
							type="button"
							className="btn-pill-dark btn-xs"
							disabled={selectedAdjustIds.size === 0 || applyingAdjustments}
							onClick={() => void handleApplyAdjustments()}
						>
							{applyingAdjustments ? "应用中…" : `确认应用所选调整 (${selectedAdjustIds.size})`}
						</button>
					</div>
				</div>
			)}

			{(formation || proposals.length > 0) && (
				<div className="meta-proposals-tray">
					{formation && (
						<div className="notice-card meta-formation-note">
							<strong>建议阵型 · {FORMATION_MODE_LABELS[formation.mode] ?? formation.mode}：</strong>
							<span>{formation.rationale || "按拟定人数与站位协同"}</span>
						</div>
					)}

					{proposals.length > 0 && (
						<>
							<div className="architect-preview-head">
								<strong>
									勾选要加入团队的新角色（{selectedIndexes.size}/{proposals.length}）
								</strong>
							</div>
							<div className="meta-blueprint-grid">
								{proposals.map((item, idx) => {
									const checked = selectedIndexes.has(idx);
									const tpl = item.draft.template;
									return (
										<div
											key={`${tpl.id}_${idx}`}
											className={`meta-blueprint-card ${checked ? "selected" : ""}`}
										>
											<label className="meta-blueprint-check">
												<input type="checkbox" checked={checked} onChange={() => toggleProposal(idx)} />
												<span>纳入创建</span>
												<span className="pill">{item.draft.toolSummary}</span>
											</label>
											<div className="form-grid">
												<input
													className="input-field"
													aria-label={`角色 ${idx + 1} 名称`}
													value={tpl.name}
													onChange={(e) => updateProposalField(idx, "name", e.target.value)}
												/>
												<input
													className="input-field"
													aria-label={`角色 ${idx + 1} 头衔`}
													value={tpl.title}
													onChange={(e) => updateProposalField(idx, "title", e.target.value)}
												/>
											</div>
											{item.rationale && <div className="meta-blueprint-rationale">{item.rationale}</div>}
											<pre className="meta-blueprint-body">{tpl.sections.responsibilitiesAndBoundaries}</pre>
										</div>
									);
								})}
							</div>
							<div className="form-footer">
								<button type="button" className="btn-pill-outline" onClick={onClose}>
									取消
								</button>
								<button
									type="button"
									className="btn-pill-dark"
									disabled={selectedIndexes.size === 0 || saving}
									onClick={() => void handleConfirmSelected()}
								>
									{saving ? "正在创建…" : `创建所选角色 (${selectedIndexes.size})`}
								</button>
							</div>
						</>
					)}
				</div>
			)}
		</div>
	);
}
