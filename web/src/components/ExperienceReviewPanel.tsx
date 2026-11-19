import { useEffect, useState } from "react";
import {
	evaluateMemberMemory,
	type MemberMemoryDto,
	type MemoryCategory,
	type MemoryScope,
	type MemoryStatus,
	type OrganizationDto,
	saveMemberMemory,
	type TeamMemberDto,
	updateMemberMemory,
	type WorkspaceDto,
} from "../api.ts";
import {
	getMemberThemeById,
	MEMORY_CATEGORY_LABELS,
	MEMORY_CATEGORY_VALUES,
	MEMORY_SCOPE_LABELS,
	MEMORY_SCOPE_SHORT_LABELS,
	MEMORY_STATUS_LABELS,
	pickDefaultWorkspaceId,
} from "../utils.ts";

interface ExperienceItemCardProps {
	memory: MemberMemoryDto;
	members: TeamMemberDto[];
	workspaces: WorkspaceDto[];
	organizations?: OrganizationDto[];
	defaultWorkspaceId?: string | null;
	memberName: (id: string) => string;
	workspaceName: (id: string | null) => string | null;
	organizationName?: (id: string | null) => string | null;
	showMemberBadge?: boolean;
	canManage?: boolean;
	onOpenMatter?: (matterId: string) => void;
	onOpenDeliverable?: (deliverableId: string) => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

export function ExperienceItemCard({
	memory,
	members,
	workspaces,
	organizations = [],
	defaultWorkspaceId = null,
	memberName,
	workspaceName,
	organizationName,
	showMemberBadge = false,
	canManage = true,
	onOpenMatter,
	onOpenDeliverable,
	onRefresh,
	onNotice,
	onError,
}: ExperienceItemCardProps) {
	const fallbackWorkspaceId = pickDefaultWorkspaceId(workspaces, memory.workspaceId, defaultWorkspaceId);
	const defaultOrgFallbackId = organizations.find((org) => org.isDefault)?.id ?? organizations[0]?.id ?? "";
	const fallbackOrgId =
		memory.orgId ?? workspaces.find((ws) => ws.id === fallbackWorkspaceId)?.orgId ?? defaultOrgFallbackId;
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [editMemberId, setEditMemberId] = useState(memory.memberId);
	const [editCategory, setEditCategory] = useState<MemoryCategory>(memory.category ?? "general");
	const [editScope, setEditScope] = useState<MemoryScope>(memory.scope);
	const [editOrgId, setEditOrgId] = useState<string>(fallbackOrgId);
	const [editWorkspaceId, setEditWorkspaceId] = useState<string>(fallbackWorkspaceId);
	const [editContent, setEditContent] = useState(memory.content);
	const [editRationale, setEditRationale] = useState(memory.rationale ?? "");

	const status: MemoryStatus = memory.status ?? (memory.verified ? "verified" : "candidate");
	const category: MemoryCategory = memory.category ?? "general";
	const orgLabel = memory.orgId
		? (organizationName?.(memory.orgId) ?? organizations.find((org) => org.id === memory.orgId)?.name ?? memory.orgId)
		: null;
	const wsLabel = memory.workspaceId ? workspaceName(memory.workspaceId) : null;
	const scopeShort = MEMORY_SCOPE_SHORT_LABELS[memory.scope] ?? memory.scope;
	const scopeText =
		memory.scope === "role_general"
			? scopeShort
			: memory.scope === "company_private"
				? orgLabel
					? `${scopeShort}：${orgLabel}`
					: wsLabel
						? `${scopeShort}：${wsLabel}`
						: scopeShort
				: wsLabel
					? `${scopeShort}：${wsLabel}`
					: scopeShort;
	const needsReview = status === "verified" && (memory.negativeCount ?? 0) > (memory.positiveCount ?? 0);
	const appliedCount = memory.appliedCount ?? 0;
	const positiveCount = memory.positiveCount ?? 0;
	const negativeCount = memory.negativeCount ?? 0;
	const hasTelemetry = appliedCount > 0 || positiveCount > 0 || negativeCount > 0;
	const theme = getMemberThemeById(members, memory.memberId);

	const runAction = async (fn: () => Promise<void>, successMessage: string) => {
		setBusy(true);
		try {
			await fn();
			onNotice(successMessage);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const openEditor = () => {
		setEditMemberId(memory.memberId);
		setEditCategory(memory.category ?? "general");
		setEditScope(memory.scope);
		const nextWsId = pickDefaultWorkspaceId(workspaces, memory.workspaceId, defaultWorkspaceId);
		setEditWorkspaceId(nextWsId);
		setEditOrgId(memory.orgId ?? workspaces.find((ws) => ws.id === nextWsId)?.orgId ?? organizations[0]?.id ?? "");
		setEditContent(memory.content);
		setEditRationale(memory.rationale ?? "");
		setEditing(true);
	};

	const saveEdit = async () => {
		const content = editContent.trim();
		if (!content) return;
		const resolvedOrgId = editScope === "company_private" ? editOrgId || null : null;
		const resolvedWsId =
			editScope === "role_general" || (editScope === "company_private" && resolvedOrgId)
				? null
				: pickDefaultWorkspaceId(workspaces, editWorkspaceId, memory.workspaceId, defaultWorkspaceId) || null;
		if (editScope === "project_private" && !resolvedWsId) {
			onError("仓库经验需要绑定一个工作区仓库");
			return;
		}
		if (editScope === "company_private" && !resolvedOrgId && !resolvedWsId) {
			onError("组织经验需要绑定一个组织或工作区仓库");
			return;
		}
		await runAction(async () => {
			await updateMemberMemory(memory.id, {
				memberId: editMemberId !== memory.memberId ? editMemberId : undefined,
				category: editCategory,
				content,
				rationale: editRationale.trim(),
				scope: editScope,
				orgId: resolvedOrgId,
				workspaceId: resolvedWsId,
			});
			setEditing(false);
		}, "经验内容、分类与归属已更新");
	};

	return (
		<div className={`memory-item memory-item-${status}`}>
			<div className="memory-item-head">
				<div className="memory-item-badges">
					{showMemberBadge && (
						<span className="pill memory-member-pill" title={`归属岗位：${memberName(memory.memberId)}`}>
							<span className="member-dot" style={{ background: theme.bg }} />
							{memberName(memory.memberId)}
						</span>
					)}
					<span className={`rsi-badge rsi-status-${status}`}>{MEMORY_STATUS_LABELS[status] ?? status}</span>
					<span className={`rsi-badge rsi-cat-${category}`}>{MEMORY_CATEGORY_LABELS[category] ?? "通用经验"}</span>
					<span className="pill">{scopeText}</span>
					{needsReview && <span className="rsi-badge rsi-alert">待复核</span>}
				</div>
				{hasTelemetry && (
					<span className="memory-telemetry">
						命中 {appliedCount} · +{positiveCount} / -{negativeCount}
					</span>
				)}
			</div>

			{canManage && editing ? (
				<div className="memory-edit-form">
					<div className="memory-draft-controls">
						{members.length > 0 && (
							<select
								className="select-sm"
								aria-label="归属岗位"
								value={editMemberId}
								onChange={(e) => setEditMemberId(e.target.value)}
							>
								{members.map((m) => (
									<option key={m.id} value={m.id}>
										归属：{m.displayName}
									</option>
								))}
							</select>
						)}
						<select
							className="select-sm"
							aria-label="经验维度"
							value={editCategory}
							onChange={(e) => setEditCategory(e.target.value as MemoryCategory)}
						>
							{MEMORY_CATEGORY_VALUES.map((cat) => (
								<option key={cat} value={cat}>
									{MEMORY_CATEGORY_LABELS[cat]}
								</option>
							))}
						</select>
						<select
							className="select-sm"
							aria-label="生效范围"
							value={editScope}
							onChange={(e) => {
								const nextScope = e.target.value as MemoryScope;
								setEditScope(nextScope);
								if (nextScope !== "role_general" && !workspaces.some((ws) => ws.id === editWorkspaceId)) {
									setEditWorkspaceId(fallbackWorkspaceId);
								}
								if (nextScope === "company_private" && !editOrgId && organizations.length > 0) {
									const wsOrg = workspaces.find(
										(ws) => ws.id === (editWorkspaceId || fallbackWorkspaceId),
									)?.orgId;
									setEditOrgId(wsOrg ?? organizations[0]?.id ?? "");
								}
							}}
						>
							<option value="role_general">{MEMORY_SCOPE_LABELS.role_general}</option>
							<option value="project_private" disabled={workspaces.length === 0}>
								{MEMORY_SCOPE_LABELS.project_private}
							</option>
							<option value="company_private" disabled={workspaces.length === 0 && organizations.length === 0}>
								{MEMORY_SCOPE_LABELS.company_private}
							</option>
						</select>
						{editScope === "company_private" && organizations.length > 0 && (
							<select
								className="select-sm"
								aria-label="绑定组织"
								value={editOrgId}
								onChange={(e) => setEditOrgId(e.target.value)}
							>
								{organizations.map((org) => (
									<option key={org.id} value={org.id}>
										组织：{org.name}
									</option>
								))}
								{workspaces.length > 0 && <option value="">仅当前单个仓库</option>}
							</select>
						)}
						{(editScope === "project_private" || (editScope === "company_private" && !editOrgId)) &&
							workspaces.length > 0 && (
								<select
									className="select-sm"
									aria-label="绑定仓库"
									value={
										workspaces.some((ws) => ws.id === editWorkspaceId) ? editWorkspaceId : fallbackWorkspaceId
									}
									onChange={(e) => setEditWorkspaceId(e.target.value)}
								>
									{workspaces.map((ws) => (
										<option key={ws.id} value={ws.id}>
											{ws.name}
										</option>
									))}
								</select>
							)}
					</div>
					<input
						className="input-field"
						value={editContent}
						onChange={(e) => setEditContent(e.target.value)}
						placeholder="经验内容（建议写成可执行规则或动作）"
					/>
					<input
						className="input-field"
						value={editRationale}
						onChange={(e) => setEditRationale(e.target.value)}
						placeholder="沉淀依据 / 触发场景（可选）"
					/>
					<div className="memory-item-actions">
						<button
							type="button"
							className="btn-pill-dark btn-xs"
							disabled={busy}
							onClick={() => void saveEdit()}
						>
							保存修改
						</button>
						<button type="button" className="btn-pill-outline btn-xs" onClick={() => setEditing(false)}>
							取消
						</button>
					</div>
				</div>
			) : (
				<>
					<div className="memory-item-content">{memory.content}</div>
					{memory.rationale && <div className="memory-rationale">依据：{memory.rationale}</div>}
					{(memory.supersedesMemoryId ||
						memory.supersededBy ||
						memory.sourceMatterId ||
						memory.sourceDeliverableId) && (
						<div className="memory-source-row">
							{memory.supersedesMemoryId && <span>替代旧规则 {memory.supersedesMemoryId}</span>}
							{memory.supersededBy && <span>已被 {memory.supersededBy} 替代</span>}
							{onOpenMatter && memory.sourceMatterId && (
								<button
									type="button"
									className="btn-inline btn-xs"
									onClick={() => onOpenMatter(memory.sourceMatterId!)}
								>
									查看原对话 →
								</button>
							)}
							{onOpenDeliverable && memory.sourceDeliverableId && (
								<button
									type="button"
									className="btn-inline btn-xs"
									onClick={() => onOpenDeliverable(memory.sourceDeliverableId!)}
								>
									查看来源成果 →
								</button>
							)}
						</div>
					)}
					{canManage && (
						<div className="memory-item-actions">
							{(status === "candidate" || status === "rejected") && (
								<button
									type="button"
									className="btn-pill-dark btn-xs"
									disabled={busy}
									onClick={() =>
										void runAction(async () => {
											await updateMemberMemory(memory.id, { status: "verified" });
										}, "已核验通过，后续同岗位或同仓库任务会自动注入")
									}
								>
									核验通过
								</button>
							)}
							{status === "verified" && (
								<>
									<button
										type="button"
										className="btn-pill-outline btn-xs"
										disabled={busy}
										onClick={() =>
											void runAction(async () => {
												await evaluateMemberMemory(memory.id, { outcome: "positive" });
											}, "已记录正向验证（+1）")
										}
									>
										+1 有效
									</button>
									<button
										type="button"
										className="btn-pill-outline btn-xs"
										disabled={busy}
										onClick={() =>
											void runAction(async () => {
												await evaluateMemberMemory(memory.id, { outcome: "negative" });
											}, "已记录存疑反馈（-1）")
										}
									>
										-1 存疑
									</button>
								</>
							)}
							{status !== "superseded" && (
								<button type="button" className="btn-inline btn-xs" disabled={busy} onClick={openEditor}>
									编辑
								</button>
							)}
							{(status === "candidate" || status === "verified") && (
								<button
									type="button"
									className="btn-inline btn-xs"
									disabled={busy}
									onClick={() =>
										void runAction(async () => {
											await updateMemberMemory(memory.id, { status: "rejected" });
										}, "已忽略该经验（不会注入新任务）")
									}
								>
									忽略
								</button>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
}

interface ManualExperienceFormProps {
	members: TeamMemberDto[];
	workspaces: WorkspaceDto[];
	organizations?: OrganizationDto[];
	defaultMemberId: string;
	allowSelectMember?: boolean;
	defaultWorkspaceId?: string | null;
	sourceMatterId?: string;
	sourceDeliverableId?: string;
	defaultContent?: string;
	headerLabel?: string;
	onSaved?: () => void;
	onCancel?: () => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

export function ManualExperienceForm({
	members,
	workspaces,
	organizations = [],
	defaultMemberId,
	allowSelectMember = true,
	defaultWorkspaceId = null,
	sourceMatterId,
	sourceDeliverableId,
	defaultContent = "",
	headerLabel,
	onSaved,
	onCancel,
	onRefresh,
	onNotice,
	onError,
}: ManualExperienceFormProps) {
	const fallbackWorkspaceId = pickDefaultWorkspaceId(workspaces, defaultWorkspaceId);
	const defaultOrgFallbackId = organizations.find((org) => org.isDefault)?.id ?? organizations[0]?.id ?? "";
	const defaultWsOrgId = workspaces.find((ws) => ws.id === fallbackWorkspaceId)?.orgId ?? defaultOrgFallbackId;
	const [memberId, setMemberId] = useState(defaultMemberId);
	const [category, setCategory] = useState<MemoryCategory>("efficiency");
	const [scope, setScope] = useState<MemoryScope>(defaultWorkspaceId ? "project_private" : "role_general");
	const [orgId, setOrgId] = useState<string>(defaultWsOrgId);
	const [workspaceId, setWorkspaceId] = useState<string>(fallbackWorkspaceId);
	const [status, setStatus] = useState<"verified" | "candidate">("verified");
	const [rationale, setRationale] = useState("");
	const [content, setContent] = useState(defaultContent);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setMemberId(defaultMemberId);
	}, [defaultMemberId]);

	useEffect(() => {
		if (defaultWorkspaceId && workspaces.some((ws) => ws.id === defaultWorkspaceId)) {
			setWorkspaceId(defaultWorkspaceId);
			const nextOrg = workspaces.find((ws) => ws.id === defaultWorkspaceId)?.orgId ?? "";
			if (nextOrg) setOrgId(nextOrg);
		}
	}, [defaultWorkspaceId, workspaces]);

	const selectedMemberName = members.find((m) => m.id === memberId)?.displayName ?? "对应岗位";

	const handleSave = async () => {
		const trimmed = content.trim();
		if (!trimmed || !memberId) return;
		const resolvedOrgId = scope === "company_private" ? orgId || null : null;
		const resolvedWsId =
			scope === "role_general" || (scope === "company_private" && resolvedOrgId)
				? undefined
				: pickDefaultWorkspaceId(workspaces, workspaceId, defaultWorkspaceId) || undefined;
		if (scope === "project_private" && !resolvedWsId) {
			onError("仓库经验或规范需要至少一个已关联的工作区仓库");
			return;
		}
		if (scope === "company_private" && !resolvedOrgId && !resolvedWsId) {
			onError("组织经验需要绑定一个组织或工作区仓库");
			return;
		}
		setSaving(true);
		try {
			await saveMemberMemory({
				memberId,
				content: trimmed,
				scope,
				category,
				orgId: resolvedOrgId,
				workspaceId: resolvedWsId,
				sourceMatterId,
				sourceDeliverableId,
				rationale: rationale.trim() || undefined,
				status,
				verified: status === "verified",
			});
			setContent("");
			setRationale("");
			onNotice(`已为「${selectedMemberName}」保存${status === "candidate" ? "待核验候选经验" : "已验证经验"}`);
			await onRefresh();
			onSaved?.();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="memory-draft-box">
			<div className="memory-draft-head">
				<h4 className="ui-sub-heading">{headerLabel ?? `手动沉淀经验（当前归属：${selectedMemberName}）`}</h4>
				<div className="memory-draft-controls">
					{allowSelectMember && members.length > 0 && (
						<select
							className="select-sm"
							aria-label="沉淀给哪个岗位"
							value={memberId}
							onChange={(e) => setMemberId(e.target.value)}
						>
							{members.map((m) => (
								<option key={m.id} value={m.id}>
									给 {m.displayName}
								</option>
							))}
						</select>
					)}
					<select
						className="select-sm"
						aria-label="经验维度"
						value={category}
						onChange={(e) => setCategory(e.target.value as MemoryCategory)}
					>
						{MEMORY_CATEGORY_VALUES.map((cat) => (
							<option key={cat} value={cat}>
								{MEMORY_CATEGORY_LABELS[cat]}
							</option>
						))}
					</select>
					<select
						className="select-sm"
						aria-label="生效范围"
						value={scope}
						onChange={(e) => {
							const nextScope = e.target.value as MemoryScope;
							setScope(nextScope);
							if (nextScope === "company_private" && !orgId && organizations.length > 0) {
								const wsOrg = workspaces.find((ws) => ws.id === workspaceId)?.orgId;
								setOrgId(wsOrg ?? organizations[0]?.id ?? "");
							}
						}}
					>
						<option value="role_general">{MEMORY_SCOPE_LABELS.role_general}</option>
						<option value="project_private" disabled={workspaces.length === 0}>
							{MEMORY_SCOPE_LABELS.project_private}
						</option>
						<option value="company_private" disabled={workspaces.length === 0 && organizations.length === 0}>
							{MEMORY_SCOPE_LABELS.company_private}
						</option>
					</select>
					{scope === "company_private" && organizations.length > 0 && (
						<select
							className="select-sm"
							aria-label="绑定组织"
							value={orgId}
							onChange={(e) => setOrgId(e.target.value)}
						>
							{organizations.map((org) => (
								<option key={org.id} value={org.id}>
									组织：{org.name}
								</option>
							))}
							{workspaces.length > 0 && <option value="">仅当前单个仓库</option>}
						</select>
					)}
					{(scope === "project_private" || (scope === "company_private" && !orgId)) && workspaces.length > 0 && (
						<select
							className="select-sm"
							aria-label="绑定仓库"
							value={workspaces.some((ws) => ws.id === workspaceId) ? workspaceId : fallbackWorkspaceId}
							onChange={(e) => setWorkspaceId(e.target.value)}
						>
							{workspaces.map((ws) => (
								<option key={ws.id} value={ws.id}>
									{ws.name}
								</option>
							))}
						</select>
					)}
					<select
						className="select-sm"
						aria-label="初始状态"
						value={status}
						onChange={(e) => setStatus(e.target.value as "verified" | "candidate")}
					>
						<option value="verified">直接设为已验证</option>
						<option value="candidate">先存为待核验候选</option>
					</select>
				</div>
			</div>
			<input
				className="input-field"
				value={rationale}
				onChange={(e) => setRationale(e.target.value)}
				placeholder="触发场景或问题根因（例如：遇到长测试阻塞主线时先设限再并发执行）"
			/>
			<div className="feedback-row">
				<input
					className="input-field"
					value={content}
					onChange={(e) => setContent(e.target.value)}
					placeholder="写下可复用的做法规则（提效 / 排障 / 协同规范）…"
				/>
				<button
					type="button"
					className="btn-pill-dark btn-sm"
					disabled={saving || !content.trim()}
					onClick={() => void handleSave()}
				>
					{saving ? "保存中…" : "保存经验"}
				</button>
				{onCancel && (
					<button type="button" className="btn-pill-outline btn-sm" onClick={onCancel}>
						取消
					</button>
				)}
			</div>
		</div>
	);
}

interface InlineExperienceReviewSectionProps {
	matterId: string;
	deliverableId?: string;
	defaultMemberId: string;
	workspaceId: string | null;
	participantIds: string[];
	memories: MemberMemoryDto[];
	members: TeamMemberDto[];
	workspaces: WorkspaceDto[];
	organizations?: OrganizationDto[];
	memberName: (id: string) => string;
	workspaceName: (id: string | null) => string | null;
	organizationName?: (id: string | null) => string | null;
	title?: string;
	lastDistillNote?: string | null;
	distilling?: boolean;
	onDistill?: () => void;
	onCancelDistill?: () => void;
	onOpenTeam?: () => void;
	manualOpen?: boolean;
	onToggleManual?: () => void;
	showManualToggle?: boolean;
	canManage?: boolean;
	defaultManualContent?: string;
	hideEmptyPlaceholder?: boolean;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

export function InlineExperienceReviewSection({
	matterId,
	deliverableId,
	defaultMemberId,
	workspaceId,
	participantIds,
	memories,
	members,
	workspaces,
	organizations = [],
	memberName,
	workspaceName,
	organizationName,
	title = "本次协作提炼与关联经验",
	lastDistillNote,
	distilling = false,
	onDistill,
	onCancelDistill,
	onOpenTeam,
	manualOpen,
	onToggleManual,
	showManualToggle = true,
	canManage = true,
	defaultManualContent = "",
	hideEmptyPlaceholder = false,
	onRefresh,
	onNotice,
	onError,
}: InlineExperienceReviewSectionProps) {
	const [internalManualOpen, setInternalManualOpen] = useState(false);
	const [batchApproving, setBatchApproving] = useState(false);
	const [confirmDistill, setConfirmDistill] = useState(false);
	const isManualOpen = manualOpen ?? internalManualOpen;
	const toggleManual = onToggleManual ?? (() => setInternalManualOpen((prev) => !prev));

	const pendingMemories = memories.filter(
		(m) => (m.status ?? (m.verified ? "verified" : "candidate")) === "candidate",
	);
	const participantNames = participantIds.map((id) => memberName(id)).filter(Boolean);

	const handleApproveAll = async () => {
		if (pendingMemories.length === 0) return;
		setBatchApproving(true);
		try {
			await Promise.all(pendingMemories.map((m) => updateMemberMemory(m.id, { status: "verified" })));
			onNotice(`已在本页直接核验通过 ${pendingMemories.length} 条经验，后续相关任务会自动注入`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setBatchApproving(false);
		}
	};

	return (
		<div className="inline-experience-section">
			<div className="inline-experience-head">
				<div className="inline-experience-title-group">
					<h3 className="ui-sub-heading">{title}</h3>
					{memories.length > 0 && (
						<span className="pill">
							{memories.length} 条{pendingMemories.length > 0 ? ` · ${pendingMemories.length} 待核验` : ""}
						</span>
					)}
					{participantNames.length > 0 && (
						<span className="inline-participants-note">参与角色：{participantNames.join("、")}</span>
					)}
				</div>
				<div className="memory-draft-controls">
					{canManage &&
						onDistill &&
						(distilling ? (
							<>
								<button type="button" className="btn-pill-outline btn-xs" disabled>
									AI 复盘提炼中...
								</button>
								{onCancelDistill && (
									<button type="button" className="btn-stop-pill" onClick={onCancelDistill}>
										取消提炼
									</button>
								)}
							</>
						) : confirmDistill ? (
							<>
								<button
									type="button"
									className="btn-pill-dark btn-xs"
									onClick={() => {
										setConfirmDistill(false);
										onDistill();
									}}
								>
									确认 AI 复盘提炼
								</button>
								<button type="button" className="btn-inline btn-xs" onClick={() => setConfirmDistill(false)}>
									取消
								</button>
							</>
						) : (
							<button type="button" className="btn-pill-outline btn-xs" onClick={() => setConfirmDistill(true)}>
								AI 复盘提炼团队经验
							</button>
						))}
					{canManage && showManualToggle && (
						<button type="button" className="btn-pill-outline btn-xs" onClick={toggleManual}>
							{isManualOpen ? "收起手动录入" : "+ 手动录入"}
						</button>
					)}
					{canManage && pendingMemories.length > 0 && (
						<button
							type="button"
							className="btn-pill-dark btn-xs"
							disabled={batchApproving}
							onClick={() => void handleApproveAll()}
						>
							{batchApproving ? "核验中…" : `全部核验通过 (${pendingMemories.length})`}
						</button>
					)}
					{onOpenTeam && (
						<button type="button" className="btn-inline btn-xs" onClick={onOpenTeam}>
							去团队经验总库 →
						</button>
					)}
				</div>
			</div>

			{lastDistillNote && <div className="distill-result-note">{lastDistillNote}</div>}

			{canManage && isManualOpen && (
				<ManualExperienceForm
					members={members}
					workspaces={workspaces}
					organizations={organizations}
					defaultMemberId={defaultMemberId}
					allowSelectMember={true}
					defaultWorkspaceId={workspaceId}
					sourceMatterId={matterId}
					sourceDeliverableId={deliverableId}
					defaultContent={defaultManualContent}
					onSaved={() => {
						if (manualOpen === undefined) setInternalManualOpen(false);
					}}
					onCancel={toggleManual}
					onRefresh={onRefresh}
					onNotice={onNotice}
					onError={onError}
				/>
			)}

			{memories.length === 0 ? (
				!hideEmptyPlaceholder &&
				!isManualOpen && (
					<div className="memory-empty-note">
						暂无关联经验。可点击上方「AI
						复盘提炼团队经验」，从用户纠偏、角色协同、排障与提效过程自动提炼并在此直接核验。
					</div>
				)
			) : (
				<div className="inline-experience-list">
					{memories.map((mem) => (
						<ExperienceItemCard
							key={mem.id}
							memory={mem}
							members={members}
							workspaces={workspaces}
							organizations={organizations}
							defaultWorkspaceId={workspaceId}
							memberName={memberName}
							workspaceName={workspaceName}
							organizationName={organizationName}
							showMemberBadge={true}
							canManage={canManage}
							onRefresh={onRefresh}
							onNotice={onNotice}
							onError={onError}
						/>
					))}
				</div>
			)}
		</div>
	);
}
