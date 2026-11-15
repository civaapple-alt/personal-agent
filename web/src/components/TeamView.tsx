import { type ChangeEvent, useState } from "react";
import {
	createMember,
	exportMemberPackage,
	importMemberPackage,
	type MemberMemoryDto,
	type MemoryCategory,
	type MemoryStatus,
	type RoleTemplateDto,
	setPrimaryMember,
	type TeamMemberDto,
	updateMemberMemory,
	type WorkspaceDto,
} from "../api.ts";
import { getBotTheme, MEMORY_CATEGORY_LABELS, MEMORY_CATEGORY_VALUES, splitTagsInput } from "../utils.ts";
import { BotFaceIcon } from "./BotFaceIcon.tsx";
import { ExperienceItemCard, ManualExperienceForm } from "./ExperienceReviewPanel.tsx";

interface TeamViewProps {
	members: TeamMemberDto[];
	workspaces: WorkspaceDto[];
	memoriesByMember: Record<string, MemberMemoryDto[]>;
	templateByRoleId: Map<string, RoleTemplateDto>;
	memberName: (id: string) => string;
	workspaceName: (id: string | null) => string | null;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
	onAssignTask: (memberId: string) => void;
	onOpenMatter?: (matterId: string) => void;
	onOpenDeliverable?: (deliverableId: string) => void;
}

type MemoryFilterTab = "all" | "candidate" | "verified" | "archived";

export function TeamView({
	members,
	workspaces,
	memoriesByMember,
	templateByRoleId,
	memberName,
	workspaceName,
	onRefresh,
	onNotice,
	onError,
	onAssignTask,
	onOpenMatter,
	onOpenDeliverable,
}: TeamViewProps) {
	const [showAddMember, setShowAddMember] = useState(false);
	const [newMemberName, setNewMemberName] = useState("");
	const [newMemberTitle, setNewMemberTitle] = useState("");
	const [newMemberResp, setNewMemberResp] = useState("");
	const [newMemberKeywords, setNewMemberKeywords] = useState("");
	const [newMemberSkills, setNewMemberSkills] = useState("");
	const [newMemberPrimary, setNewMemberPrimary] = useState(false);

	const [showImportMember, setShowImportMember] = useState(false);
	const [importMarkdown, setImportMarkdown] = useState("");
	const [exportedPackage, setExportedPackage] = useState<{
		id: string;
		filename: string;
		markdown: string;
	} | null>(null);
	const [expandedMemoryMemberId, setExpandedMemoryMemberId] = useState<string | null>(null);
	const [memoryFilter, setMemoryFilter] = useState<MemoryFilterTab>("all");
	const [categoryFilter, setCategoryFilter] = useState<"all" | MemoryCategory>("all");
	const [showAddMemoryFor, setShowAddMemoryFor] = useState<string | null>(null);
	const [batchApprovingMemberId, setBatchApprovingMemberId] = useState<string | null>(null);

	const handleApproveAllCandidates = async (member: TeamMemberDto, candidates: MemberMemoryDto[]) => {
		if (candidates.length === 0) return;
		setBatchApprovingMemberId(member.id);
		try {
			await Promise.all(candidates.map((m) => updateMemberMemory(m.id, { status: "verified" })));
			onNotice(`已将「${member.displayName}」的 ${candidates.length} 条待核验经验全部核验通过`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setBatchApprovingMemberId(null);
		}
	};

	const handleCreateMember = async () => {
		if (!newMemberName.trim() || !newMemberTitle.trim()) return;
		try {
			const res = await createMember({
				name: newMemberName.trim(),
				title: newMemberTitle.trim(),
				responsibilities: newMemberResp.trim() || undefined,
				keywords: splitTagsInput(newMemberKeywords),
				skills: splitTagsInput(newMemberSkills),
				isPrimaryContact: newMemberPrimary,
			});
			setNewMemberName("");
			setNewMemberTitle("");
			setNewMemberResp("");
			setNewMemberKeywords("");
			setNewMemberSkills("");
			setNewMemberPrimary(false);
			setShowAddMember(false);
			onNotice(`新同事「${res.member.displayName}」已加入团队`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleSetPrimary = async (memberId: string) => {
		await setPrimaryMember(memberId);
		onNotice(`已将「${memberName(memberId)}」设为默认主联系人`);
		await onRefresh();
	};

	const handleExportMember = async (memberId: string) => {
		const pkg = await exportMemberPackage(memberId);
		setExportedPackage(pkg);
	};

	const handleImportMember = async () => {
		if (!importMarkdown.trim()) return;
		try {
			const res = await importMemberPackage(importMarkdown);
			setImportMarkdown("");
			setShowImportMember(false);
			onNotice(`已导入角色「${res.member.displayName}」`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleImportFileChange = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === "string") {
				setImportMarkdown(reader.result);
			}
		};
		reader.readAsText(file);
	};

	const handleDownloadExportedPackage = () => {
		if (!exportedPackage) return;
		const blob = new Blob([exportedPackage.markdown], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = exportedPackage.filename;
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="subpage-scroll">
			<div className="subpage-inner wide">
				<div className="pane-header-row">
					<div className="pane-header">
						<h1>我的团队</h1>
						<p>查看角色分工与积累经验，支持新增自定义角色，或导入导出脱敏角色能力包</p>
					</div>
					<div className="actions-row" style={{ marginTop: 0 }}>
						<button
							type="button"
							className="btn-pill-dark"
							onClick={() => {
								setShowAddMember((v) => !v);
								setShowImportMember(false);
							}}
						>
							+ 新增角色
						</button>
						<button
							type="button"
							className="btn-pill-outline"
							onClick={() => {
								setShowImportMember((v) => !v);
								setShowAddMember(false);
							}}
						>
							导入角色包
						</button>
					</div>
				</div>

				{showAddMember && (
					<div className="deliverable-card form-card">
						<h3 className="section-title">组建新角色</h3>
						<div className="form-grid">
							<input
								className="input-field"
								placeholder="角色名称（如：架构师）"
								value={newMemberName}
								onChange={(e) => setNewMemberName(e.target.value)}
							/>
							<input
								className="input-field"
								placeholder="职位头衔（如：System Architect）"
								value={newMemberTitle}
								onChange={(e) => setNewMemberTitle(e.target.value)}
							/>
						</div>
						<textarea
							rows={2}
							className="composer-input"
							placeholder="核心职责描述（例如：负责系统架构选型、模块解耦和性能瓶颈排查）"
							value={newMemberResp}
							onChange={(e) => setNewMemberResp(e.target.value)}
						/>
						<div className="form-grid">
							<input
								className="input-field"
								placeholder="路由关键词（逗号分隔，如：架构,性能,重构）"
								value={newMemberKeywords}
								onChange={(e) => setNewMemberKeywords(e.target.value)}
							/>
							<input
								className="input-field"
								placeholder="能力技能（逗号分隔，如：architecture-review,rfc）"
								value={newMemberSkills}
								onChange={(e) => setNewMemberSkills(e.target.value)}
							/>
						</div>
						<div className="form-footer">
							<label className="checkbox-label">
								<input
									type="checkbox"
									checked={newMemberPrimary}
									onChange={(e) => setNewMemberPrimary(e.target.checked)}
								/>
								<span>设为默认主联系人</span>
							</label>
							<div style={{ display: "flex", gap: 8 }}>
								<button type="button" className="btn-pill-outline" onClick={() => setShowAddMember(false)}>
									取消
								</button>
								<button type="button" className="btn-pill-dark" onClick={() => void handleCreateMember()}>
									加入团队
								</button>
							</div>
						</div>
					</div>
				)}

				{showImportMember && (
					<div className="deliverable-card form-card">
						<h3 className="section-title">导入团队成员能力包（.md）</h3>
						<p className="muted-hint">
							支持粘贴或选择导出的角色 Markdown 模板。导入后立即注册到当前团队，不包含他人私有项目记忆。
						</p>
						<label className="file-upload-label">
							<span>选择本地 .md 文件：</span>
							<input type="file" accept=".md,text/markdown" onChange={handleImportFileChange} />
						</label>
						<textarea
							rows={6}
							className="composer-input mono-input"
							placeholder="粘贴角色模板 Markdown（含 --- frontmatter ---）..."
							value={importMarkdown}
							onChange={(e) => setImportMarkdown(e.target.value)}
						/>
						<div className="actions-row">
							<button type="button" className="btn-pill-dark" onClick={() => void handleImportMember()}>
								确认导入
							</button>
							<button type="button" className="btn-pill-outline" onClick={() => setShowImportMember(false)}>
								取消
							</button>
						</div>
					</div>
				)}

				{exportedPackage && (
					<div className="deliverable-card form-card">
						<div className="banner-row">
							<h3 className="section-title">已导出脱敏能力包：{exportedPackage.filename}</h3>
							<button type="button" className="btn-inline" onClick={() => setExportedPackage(null)}>
								关闭
							</button>
						</div>
						<p className="muted-hint">已自动剥离公司私有规范与项目私有记忆，仅保留角色职责、技能与工作原则。</p>
						<textarea rows={7} readOnly className="composer-input mono-input" value={exportedPackage.markdown} />
						<div className="actions-row">
							<button type="button" className="btn-pill-dark" onClick={handleDownloadExportedPackage}>
								下载 .md 文件
							</button>
							<button
								type="button"
								className="btn-pill-outline"
								onClick={() => {
									void navigator.clipboard.writeText(exportedPackage.markdown);
									onNotice("能力包 Markdown 已复制到剪贴板");
								}}
							>
								复制内容
							</button>
						</div>
					</div>
				)}

				<div className="team-grid">
					{members.map((member, idx) => {
						const tpl = templateByRoleId.get(member.templateId);
						const memories = memoriesByMember[member.id] ?? [];
						const isExpanded = expandedMemoryMemberId === member.id;
						const theme = getBotTheme(idx);
						const verifiedCount = memories.filter(
							(m) => m.status === "verified" || (!m.status && m.verified),
						).length;
						const candidateMemories = memories.filter(
							(m) => m.status === "candidate" || (!m.status && !m.verified),
						);
						const candidateCount = candidateMemories.length;
						const filteredMemories = memories.filter((m) => {
							const st: MemoryStatus = m.status ?? (m.verified ? "verified" : "candidate");
							if (memoryFilter === "candidate" && st !== "candidate") return false;
							if (memoryFilter === "verified" && st !== "verified") return false;
							if (memoryFilter === "archived" && st !== "rejected" && st !== "superseded") return false;
							const cat: MemoryCategory = m.category ?? "general";
							if (categoryFilter !== "all" && cat !== categoryFilter) return false;
							return true;
						});
						return (
							<div key={member.id} className="member-card">
								<div className="member-card-top">
									<div className="member-ident">
										<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="md" />
										<div>
											<div className="member-name-row">
												<strong>{member.displayName}</strong>
												{member.isPrimaryContact && <span className="pill live">默认主联系</span>}
											</div>
											<div className="member-sub">
												{member.roleTitle} · {member.model}
											</div>
										</div>
									</div>
									<div className="member-memory-badges">
										{candidateCount > 0 && (
											<span className="rsi-badge rsi-status-candidate">{candidateCount} 待核验</span>
										)}
										<span className="pill">{verifiedCount} 已验证</span>
									</div>
								</div>

								{tpl?.responsibilities && <p className="member-resp">{tpl.responsibilities.split("\n")[0]}</p>}

								{tpl && (tpl.keywords.length > 0 || tpl.skills.length > 0) && (
									<div className="tag-list">
										{tpl.keywords.slice(0, 4).map((kw) => (
											<span key={kw} className="tag-chip">
												#{kw}
											</span>
										))}
										{tpl.skills.map((sk) => (
											<span key={sk} className="tag-chip skill">
												{sk}
											</span>
										))}
									</div>
								)}

								<div className="actions-row">
									<button
										type="button"
										className="btn-pill-dark btn-xs"
										onClick={() => onAssignTask(member.id)}
									>
										向 TA 派活
									</button>
									{!member.isPrimaryContact && (
										<button
											type="button"
											className="btn-pill-outline btn-xs"
											onClick={() => void handleSetPrimary(member.id)}
										>
											设为主联系
										</button>
									)}
									<button
										type="button"
										className="btn-pill-outline btn-xs"
										onClick={() => void handleExportMember(member.id)}
									>
										导出能力包
									</button>
									<button
										type="button"
										className="btn-inline"
										onClick={() => setExpandedMemoryMemberId(isExpanded ? null : member.id)}
									>
										{isExpanded ? "收起经验" : `管理经验 (${memories.length})`}
									</button>
								</div>

								{isExpanded && (
									<div className="memory-list">
										<div className="memory-toolbar">
											<div className="memory-filter-tabs">
												{(
													[
														["all", `全部 (${memories.length})`],
														["candidate", `待核验 (${candidateCount})`],
														["verified", `已验证 (${verifiedCount})`],
														["archived", "已替代/忽略"],
													] as const
												).map(([key, label]) => (
													<button
														key={key}
														type="button"
														className={`choice-chip ${memoryFilter === key ? "active" : ""}`}
														onClick={() => setMemoryFilter(key)}
													>
														{label}
													</button>
												))}
											</div>
											<div className="memory-draft-controls">
												<select
													className="select-sm"
													aria-label="按经验维度筛选"
													value={categoryFilter}
													onChange={(e) => setCategoryFilter(e.target.value as "all" | MemoryCategory)}
												>
													<option value="all">全部维度</option>
													{MEMORY_CATEGORY_VALUES.map((cat) => (
														<option key={cat} value={cat}>
															{MEMORY_CATEGORY_LABELS[cat]}
														</option>
													))}
												</select>
												{candidateCount > 0 && (
													<button
														type="button"
														className="btn-pill-dark btn-xs"
														disabled={batchApprovingMemberId === member.id}
														onClick={() => void handleApproveAllCandidates(member, candidateMemories)}
													>
														{batchApprovingMemberId === member.id
															? "核验中..."
															: `全部通过 (${candidateCount})`}
													</button>
												)}
												<button
													type="button"
													className="btn-pill-outline btn-xs"
													onClick={() =>
														setShowAddMemoryFor((prev) => (prev === member.id ? null : member.id))
													}
												>
													{showAddMemoryFor === member.id ? "取消录入" : "+ 录入经验"}
												</button>
											</div>
										</div>

										{showAddMemoryFor === member.id && (
											<ManualExperienceForm
												members={members}
												workspaces={workspaces}
												defaultMemberId={member.id}
												allowSelectMember={false}
												headerLabel={`为「${member.displayName}」新增经验规则`}
												onSaved={() => setShowAddMemoryFor(null)}
												onCancel={() => setShowAddMemoryFor(null)}
												onRefresh={onRefresh}
												onNotice={onNotice}
												onError={onError}
											/>
										)}

										{filteredMemories.length === 0 ? (
											<div className="memory-empty-note">当前筛选条件下暂无经验条目。</div>
										) : (
											filteredMemories.map((mem) => (
												<ExperienceItemCard
													key={mem.id}
													memory={mem}
													members={members}
													workspaces={workspaces}
													memberName={memberName}
													workspaceName={workspaceName}
													onOpenMatter={onOpenMatter}
													onOpenDeliverable={onOpenDeliverable}
													onRefresh={onRefresh}
													onNotice={onNotice}
													onError={onError}
												/>
											))
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
