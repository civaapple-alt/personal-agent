import { useEffect, useState } from "react";
import {
	createMember,
	designRoleDraft,
	type RoleArchitectDraftDto,
	type RoleGapSuggestionDto,
	type RoleInteractionStyle,
	type RoleWorkspaceScope,
	type TeamMemberDto,
} from "../../api.ts";

interface RoleArchitectModalProps {
	open: boolean;
	seedGap?: RoleGapSuggestionDto | null;
	onClose: () => void;
	onCreated: (member: TeamMemberDto) => Promise<void> | void;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

const ANTI_JOB_SUGGESTIONS = [
	"只审核与给建议，不直接修改代码文件",
	"无实质风险或关键增量时保持静默",
	"不替代主负责人直接对外发布正式成果",
	"只基于提供的事实或文件核查，不编造未验证数据",
];

/**
 * Guided role designer inspired by `dr-eggbot-v2`:
 * clarifies one job, explicit anti-jobs, interaction style, and least-privilege tools instead of preset industry bloat.
 */
export function RoleArchitectModal({ open, seedGap, onClose, onCreated, onNotice, onError }: RoleArchitectModalProps) {
	const [oneJob, setOneJob] = useState("");
	const [antiJobsText, setAntiJobsText] = useState("");
	const [quietWhen, setQuietWhen] = useState("");
	const [interactionStyle, setInteractionStyle] = useState<RoleInteractionStyle>("consult_specialist");
	const [workspaceScope, setWorkspaceScope] = useState<RoleWorkspaceScope>("read_only_repo");
	const [workflowRules, setWorkflowRules] = useState("");
	const [roleName, setRoleName] = useState("");
	const [roleTitle, setRoleTitle] = useState("");
	const [keywordsText, setKeywordsText] = useState("");
	const [isPrimaryContact, setIsPrimaryContact] = useState(false);
	const [draft, setDraft] = useState<RoleArchitectDraftDto | null>(null);
	const [generating, setGenerating] = useState(false);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!open) return;
		setDraft(null);
		if (seedGap) {
			setOneJob(seedGap.suggestedJob);
			setAntiJobsText(seedGap.suggestedAntiJobs.join("\n"));
			setQuietWhen("");
			setInteractionStyle(seedGap.suggestedInteractionStyle);
			setWorkspaceScope(seedGap.suggestedWorkspaceScope);
			setRoleName(seedGap.missingRoleTitle);
			setRoleTitle("");
			setWorkflowRules("");
			setKeywordsText("");
			setIsPrimaryContact(false);
		} else {
			setOneJob("");
			setAntiJobsText("");
			setQuietWhen("");
			setInteractionStyle("consult_specialist");
			setWorkspaceScope("read_only_repo");
			setWorkflowRules("");
			setRoleName("");
			setRoleTitle("");
			setKeywordsText("");
			setIsPrimaryContact(false);
		}
	}, [open, seedGap]);

	if (!open) return null;

	const appendAntiJobSuggestion = (rule: string) => {
		const lines = antiJobsText
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		if (!lines.includes(rule)) {
			setAntiJobsText([...lines, rule].join("\n"));
		}
	};

	const handleGenerateDraft = async () => {
		if (!oneJob.trim() || generating) return;
		setGenerating(true);
		try {
			const res = await designRoleDraft({
				oneJob: oneJob.trim(),
				antiJobs: antiJobsText
					.split("\n")
					.map((s) => s.trim())
					.filter(Boolean),
				quietWhen: quietWhen.trim() || undefined,
				interactionStyle,
				workspaceScope,
				roleName: roleName.trim() || undefined,
				roleTitle: roleTitle.trim() || undefined,
				keywords: keywordsText
					.split(/[,，\s]+/)
					.map((s) => s.trim())
					.filter(Boolean),
				workflowRules: workflowRules.trim() || undefined,
				isPrimaryContact,
			});
			setDraft(res);
			setRoleName(res.template.name);
			setRoleTitle(res.template.title);
			setKeywordsText(res.template.keywords.join(", "));
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setGenerating(false);
		}
	};

	const handleConfirmCreate = async () => {
		if (!draft || !roleName.trim() || !roleTitle.trim() || saving) return;
		setSaving(true);
		try {
			const res = await createMember({
				name: roleName.trim(),
				title: roleTitle.trim(),
				responsibilities: draft.template.sections.responsibilitiesAndBoundaries,
				keywords: keywordsText
					.split(/[,，\s]+/)
					.map((s) => s.trim())
					.filter(Boolean),
				skills: draft.template.skills,
				tools: draft.template.tools,
				antiJobs: draft.antiJobs,
				sections: draft.template.sections,
				isPrimaryContact,
			});
			onNotice(`已按工作流程设计并创建「${res.member.displayName}」`);
			await onCreated(res.member);
			onClose();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="architect-modal-backdrop">
			<button type="button" className="architect-modal-scrim" aria-label="关闭弹窗" onClick={onClose} />
			<div className="architect-modal-card" role="dialog" aria-modal="true" aria-label="引导式角色设计助手">
				<div className="banner-row">
					<div>
						<span className="pill org-pill">角色设计官 · Role Architect</span>
						<h2 className="ui-card-title architect-modal-title">按你们的真实协作流程定制专职 AI 角色</h2>
					</div>
					<button type="button" className="btn-inline" onClick={onClose}>
						关闭
					</button>
				</div>
				<p className="ui-section-desc">
					借鉴 One Job + Explicit Anti-Jobs +
					最小工具权限原则：不套用泛行业预设，先定清晰职责与“不做清单”，再加入团队。
				</p>

				{seedGap && (
					<div className="notice-card architect-gap-banner">
						<strong>来自事项立项的缺口识别：</strong>
						<span>{seedGap.reason}</span>
					</div>
				)}

				<div className="architect-form-body">
					<label className="identity-field">
						<span className="identity-field-label">1. 它唯一核心要干的一件事是什么？（One Job）</span>
						<textarea
							rows={2}
							className="composer-input"
							placeholder="例如：只负责上线前的合同/对外条款合规风控；或者只负责汇总每日实验反馈并提炼 TOP3 痛点。"
							value={oneJob}
							onChange={(e) => {
								setOneJob(e.target.value);
								setDraft(null);
							}}
						/>
					</label>

					<div className="form-grid">
						<label className="identity-field">
							<span className="identity-field-label">2. 它在团队中以什么方式配合？（参与站位）</span>
							<select
								className="select-sm select-control"
								value={interactionStyle}
								onChange={(e) => {
									setInteractionStyle(e.target.value as RoleInteractionStyle);
									setDraft(null);
								}}
							>
								<option value="lead_direct">可作事项主责（直接统筹并交付结果）</option>
								<option value="consult_specialist">仅作内部顾问（按需受委托给专业意见）</option>
								<option value="risk_observer">定向旁听把关（仅发现重大风险时插话）</option>
								<option value="mixed">灵活协作（可主责也可被咨询）</option>
							</select>
						</label>

						<label className="identity-field">
							<span className="identity-field-label">3. 最小必要工作区工具权限（不留多余工具）</span>
							<select
								className="select-sm select-control"
								value={workspaceScope}
								onChange={(e) => {
									setWorkspaceScope(e.target.value as RoleWorkspaceScope);
									setDraft(null);
								}}
							>
								<option value="no_repo_docs">纯思考与文稿（无文件系统/命令工具）</option>
								<option value="read_only_repo">只读核查工作区（仅 read，不改代码）</option>
								<option value="read_write_code">读写源码与命令（read / edit / write / bash）</option>
							</select>
						</label>
					</div>

					<div className="identity-field">
						<span className="identity-field-label">
							4. 明确绝对不能越界做什么？（Anti-Jobs & 静默原则，每行一条）
						</span>
						<div className="architect-quick-chips">
							{ANTI_JOB_SUGGESTIONS.map((rule) => (
								<button
									key={rule}
									type="button"
									className="tag-chip architect-chip-btn"
									onClick={() => appendAntiJobSuggestion(rule)}
								>
									+ {rule}
								</button>
							))}
						</div>
						<textarea
							rows={3}
							className="composer-input"
							placeholder="每行写一条不做边界，例如：不替人类拍板商业报价；无关键风险时保持静默。"
							value={antiJobsText}
							onChange={(e) => {
								setAntiJobsText(e.target.value);
								setDraft(null);
							}}
						/>
					</div>

					<div className="form-grid">
						<label className="identity-field">
							<span className="identity-field-label">团队研发/管理流程补充约束（可选）</span>
							<input
								className="input-field"
								placeholder="如：涉及线上变更前必须先经人工确认；汇报控制在 3 条要点内"
								value={workflowRules}
								onChange={(e) => {
									setWorkflowRules(e.target.value);
									setDraft(null);
								}}
							/>
						</label>
						<label className="identity-field">
							<span className="identity-field-label">什么时候应该保持静默？（可选）</span>
							<input
								className="input-field"
								placeholder="如：无新增风险点或常规讨论时不插话"
								value={quietWhen}
								onChange={(e) => {
									setQuietWhen(e.target.value);
									setDraft(null);
								}}
							/>
						</label>
					</div>

					<div className="ui-row-actions">
						<button
							type="button"
							className="btn-pill-dark"
							disabled={!oneJob.trim() || generating}
							onClick={() => void handleGenerateDraft()}
						>
							{generating ? "生成设计草案…" : draft ? "重新生成草案" : "生成角色边界草案 →"}
						</button>
					</div>
				</div>

				{draft && (
					<div className="architect-preview-box">
						<div className="architect-preview-head">
							<strong>角色设计审查（确认边界后再加入团队）</strong>
							<span className="pill">{draft.toolSummary}</span>
						</div>

						<div className="form-grid">
							<label className="identity-field">
								<span className="identity-field-label">角色名称</span>
								<input className="input-field" value={roleName} onChange={(e) => setRoleName(e.target.value)} />
							</label>
							<label className="identity-field">
								<span className="identity-field-label">英文/职位头衔</span>
								<input
									className="input-field"
									value={roleTitle}
									onChange={(e) => setRoleTitle(e.target.value)}
								/>
							</label>
						</div>

						<label className="identity-field">
							<span className="identity-field-label">自动 routing 关键词（逗号分隔）</span>
							<input
								className="input-field"
								value={keywordsText}
								onChange={(e) => setKeywordsText(e.target.value)}
							/>
						</label>

						<div className="architect-preview-grid">
							<div className="architect-preview-pane">
								<h4>职责与明确不做（Anti-Jobs）</h4>
								<pre>{draft.template.sections.responsibilitiesAndBoundaries}</pre>
							</div>
							<div className="architect-preview-pane">
								<h4>协作约定与交付边界</h4>
								<pre>
									{[
										draft.template.sections.collaborationConventions,
										draft.template.sections.deliveryAndVerification,
									].join("\n")}
								</pre>
							</div>
						</div>

						<div className="form-footer">
							<label className="checkbox-label">
								<input
									type="checkbox"
									checked={isPrimaryContact}
									onChange={(e) => setIsPrimaryContact(e.target.checked)}
								/>
								<span>设为默认主联系人</span>
							</label>
							<div className="ui-row-actions">
								<button type="button" className="btn-pill-outline" onClick={onClose}>
									取消
								</button>
								<button
									type="button"
									className="btn-pill-dark"
									disabled={!roleName.trim() || !roleTitle.trim() || saving}
									onClick={() => void handleConfirmCreate()}
								>
									{saving ? "加入团队中…" : "确认创建并启用该角色"}
								</button>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
