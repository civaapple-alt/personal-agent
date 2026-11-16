import { useEffect, useRef, useState } from "react";
import {
	chatWithRoleArchitect,
	createMembersBatch,
	type MetaArchitectBlueprintProposalDto,
	type MetaArchitectFormationSuggestionDto,
	type MetaArchitectMessageDto,
	type RoleGapSuggestionDto,
	type TeamMemberDto,
} from "../../api.ts";

interface MetaArchitectChatPaneProps {
	open: boolean;
	seedGap?: RoleGapSuggestionDto | null;
	matterPrompt?: string;
	workspaceId?: string | null;
	onCreatedBatch: (members: TeamMemberDto[], formation?: MetaArchitectFormationSuggestionDto) => Promise<void> | void;
	onClose: () => void;
	onSwitchQuickForm: () => void;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

interface ChatTurnItem extends MetaArchitectMessageDto {
	id: string;
	followUpQuestions?: string[];
}

const FORMATION_MODE_LABELS: Record<string, string> = {
	solo: "单兵直办（1 AI）",
	lead_consult: "主责 + 指定协同",
	lead_review: "主责 + 定向旁听把关",
	human_first: "人类先讨论定调",
};

/** Conversational Meta-Bot intake & multi-role blueprint proposer (read-only until user checks and confirms creation). */
export function MetaArchitectChatPane({
	open,
	seedGap,
	matterPrompt,
	workspaceId,
	onCreatedBatch,
	onClose,
	onSwitchQuickForm,
	onNotice,
	onError,
}: MetaArchitectChatPaneProps) {
	const [turns, setTurns] = useState<ChatTurnItem[]>([]);
	const [inputText, setInputText] = useState("");
	const [sending, setSending] = useState(false);
	const [saving, setSaving] = useState(false);
	const [localError, setLocalError] = useState<string | null>(null);
	const [proposals, setProposals] = useState<MetaArchitectBlueprintProposalDto[]>([]);
	const [selectedIndexes, setSelectedIndexes] = useState<Set<number>>(new Set());
	const [formation, setFormation] = useState<MetaArchitectFormationSuggestionDto | undefined>(undefined);
	const abortRef = useRef<AbortController | null>(null);

	useEffect(() => {
		if (!open) {
			abortRef.current?.abort();
			abortRef.current = null;
			return;
		}
		setTurns([]);
		setProposals([]);
		setSelectedIndexes(new Set());
		setFormation(undefined);
		setLocalError(null);
		if (seedGap) {
			setInputText(
				`我想处理的事情缺乏合适角色：${seedGap.reason}\n请结合现有团队评估，应该补 1 个还是多个角色（各自唯一职责、不做清单和最小工具是什么），以及如何与人类配合？`,
			);
		} else if (matterPrompt?.trim()) {
			setInputText(
				`我准备发起一个新事项：「${matterPrompt.trim().slice(0, 180)}」。请帮我诊断需要几个什么角色、谁主责谁静默旁听，如果现有团队不够请设计补充角色。`,
			);
		} else {
			setInputText("");
		}
	}, [open, seedGap, matterPrompt]);

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
			};
			setTurns([...nextTurns, assistantTurn]);
			if (res.blueprints.length > 0) {
				setProposals(res.blueprints);
				setSelectedIndexes(new Set(res.blueprints.map((_, idx) => idx)));
			}
			if (res.recommendedFormation) {
				setFormation(res.recommendedFormation);
			}
		} catch (err: unknown) {
			if (controller.signal.aborted) {
				setLocalError("已取消本次架构师推敲。");
			} else {
				const msg = err instanceof Error ? err.message : String(err);
				setLocalError(`调用本机模型失败：${msg}（如当前环境未配置模型，可切换「快速 4 问规则直出」）`);
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
			onNotice(`Meta-Bot 设计已落地：新加入 ${res.members.map((m) => `「${m.displayName}」`).join("、")}`);
			await onCreatedBatch(res.members, formation);
			onClose();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="meta-architect-pane">
			<div className="meta-quick-starters">
				<button
					type="button"
					className="tag-chip architect-chip-btn"
					disabled={sending}
					onClick={() =>
						void sendMessage(
							"请帮我梳理下面这个工作流，告诉我需要几个互不重叠的 AI 角色、各自的不做清单（Anti-Jobs）以及人类在什么节点拍板：",
						)
					}
				>
					+ 按工作流规划 1~N 个角色分工
				</button>
				<button
					type="button"
					className="tag-chip architect-chip-btn"
					disabled={sending}
					onClick={() =>
						void sendMessage(
							"请结合团队近期运行摩擦和已有成员职责，做一次健康体检：看有没有职责臃肿、工具过剩或需要新增/调整防越界清单的地方。",
							true,
						)
					}
				>
					+ 对当前团队做一次协作体检
				</button>
			</div>

			<div className="meta-chat-thread" aria-live="polite">
				{turns.length === 0 ? (
					<div className="meta-empty-hint">
						<strong>对话说明：</strong>
						<span>
							描述你的目标或团队流程（例如：“我们做新产品验证，希望有人只做客户访谈提炼、另一个只挑逻辑漏洞且平时保持静默”）。架构师会先用
							2~3 个关键追问厘清边界，再给出一组最小权限角色草案供你勾选确认。
						</span>
					</div>
				) : (
					turns.map((turn) => (
						<div key={turn.id} className={`meta-turn-bubble ${turn.role}`}>
							<div className="meta-turn-role">{turn.role === "user" ? "我" : "Role Architect (Meta-Bot)"}</div>
							<div className="meta-turn-text">{turn.content}</div>
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
					))
				)}
				{sending && <div className="meta-turn-loading">Meta-Bot 正在分析团队职责边界与最小权限…</div>}
			</div>

			{localError && (
				<div className="approval-card meta-error-bar">
					<span>{localError}</span>
					<button type="button" className="btn-inline" onClick={onSwitchQuickForm}>
						改用快速 4 问规则直出 →
					</button>
				</div>
			)}

			<div className="meta-composer-row">
				<textarea
					rows={2}
					className="composer-input"
					placeholder="告诉架构师你们的工作流程、希望拆出几个角色、谁只旁听不插手、或者回答上面的追问…"
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
							停止推敲
						</button>
					) : (
						<button
							type="button"
							className="btn-pill-dark btn-xs"
							disabled={!inputText.trim()}
							onClick={() => void sendMessage()}
						>
							发送给架构师
						</button>
					)}
				</div>
			</div>

			{(formation || proposals.length > 0) && (
				<div className="meta-proposals-tray">
					{formation && (
						<div className="notice-card meta-formation-note">
							<strong>推荐协作阵型 · {FORMATION_MODE_LABELS[formation.mode] ?? formation.mode}：</strong>
							<span>{formation.rationale || "按拟定人数与站位协同"}</span>
						</div>
					)}

					{proposals.length > 0 && (
						<>
							<div className="architect-preview-head">
								<strong>待你勾选确认的角色草案（共 {proposals.length} 位，绝不自动创建）</strong>
								<span className="muted-hint">已勾选 {selectedIndexes.size} 位</span>
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
									暂不创建
								</button>
								<button
									type="button"
									className="btn-pill-dark"
									disabled={selectedIndexes.size === 0 || saving}
									onClick={() => void handleConfirmSelected()}
								>
									{saving ? "正在批量加入团队…" : `确认创建所选 ${selectedIndexes.size} 个角色`}
								</button>
							</div>
						</>
					)}
				</div>
			)}
		</div>
	);
}
