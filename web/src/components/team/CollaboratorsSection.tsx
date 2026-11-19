import { useState } from "react";
import {
	type CollaboratorDto,
	createCollaborator,
	deleteCollaborator,
	type OrganizationDto,
	regenerateCollaboratorToken,
} from "../../api.ts";
import { copyCollaboratorInviteUrl } from "../../clipboard.ts";
import { ModalDialog } from "../ModalDialog.tsx";

interface CollaboratorsSectionProps {
	isOwner: boolean;
	currentUser?: CollaboratorDto | null;
	collaborators: CollaboratorDto[];
	organizations: OrganizationDto[];
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
	onPreviewAsCollaborator?: (token: string) => void;
	onRestoreOwner?: () => void;
}

/** Manages human collaborators and LAN invitation links; creation uses a centered modal to preserve page layout. */
export function CollaboratorsSection({
	isOwner,
	currentUser,
	collaborators,
	organizations,
	onRefresh,
	onNotice,
	onError,
	onPreviewAsCollaborator,
	onRestoreOwner,
}: CollaboratorsSectionProps) {
	const [expanded, setExpanded] = useState(false);
	const [showAddCollab, setShowAddCollab] = useState(false);
	const [collabNameInput, setCollabNameInput] = useState("");
	const [collabRoleInput, setCollabRoleInput] = useState("");
	const [collabOrgInput, setCollabOrgInput] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const closeAddModal = () => {
		if (submitting) return;
		setShowAddCollab(false);
		setCollabNameInput("");
		setCollabRoleInput("");
		setCollabOrgInput("");
	};

	const handleCreateCollaborator = async () => {
		if (!collabNameInput.trim() || submitting) return;
		setSubmitting(true);
		try {
			const res = await createCollaborator({
				name: collabNameInput.trim(),
				roleTitle: collabRoleInput.trim() || "协同同事",
				orgId: collabOrgInput || null,
			});
			setCollabNameInput("");
			setCollabRoleInput("");
			setCollabOrgInput("");
			setShowAddCollab(false);
			await onRefresh();
			onNotice(`已创建同事「${res.collaborator.name}」并生成专属邀请链接`);
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	};

	const currentLabel = currentUser
		? `${currentUser.name}（${currentUser.permissionRole === "owner" ? "所有者" : "协同成员"}）`
		: "所有者";

	return (
		<section className="org-strip-card">
			<div className="ui-section-head team-admin-head">
				<div className="team-admin-summary">
					<h2 className="ui-section-title">团队同事与邀请（{collaborators.length}）</h2>
					<span className="team-admin-meta">当前：{currentLabel}</span>
				</div>
				<div className="ui-row-actions">
					{!isOwner && onRestoreOwner && (
						<button type="button" className="btn-pill-outline btn-xs" onClick={onRestoreOwner}>
							恢复所有者身份
						</button>
					)}
					{isOwner && (
						<button type="button" className="btn-pill-outline btn-xs" onClick={() => setShowAddCollab(true)}>
							+ 新增邀请同事
						</button>
					)}
					<button
						type="button"
						className="btn-inline btn-xs"
						aria-expanded={expanded}
						onClick={() => setExpanded((v) => !v)}
					>
						{expanded ? "收起 ▴" : "展开管理 ▾"}
					</button>
				</div>
			</div>

			{expanded && (
				<>
					<p className="ui-section-desc">
						所有者掌管代码执行、仓库切换与角色设置；同事通过专属邀请链接加入同一房间讨论、提请 AI 与验收评价。
					</p>
					<div className="collab-humans-list">
						{collaborators.map((col) => {
							const isSelf = currentUser?.id === col.id;
							const orgLabel = col.orgId
								? (organizations.find((o) => o.id === col.orgId)?.name ?? col.orgId)
								: null;
							return (
								<div key={col.id} className={`org-chip-card collab-human-card ${isSelf ? "is-default" : ""}`}>
									<div className="org-chip-head">
										<div className="ui-inline-head">
											<strong>{col.name}</strong>
											<span className={`pill ${col.permissionRole === "owner" ? "live" : ""}`}>
												{col.permissionRole === "owner" ? "所有者" : "协同成员"}
											</span>
											{isSelf && <span className="roster-me">当前视角</span>}
										</div>
									</div>
									<div className="org-chip-meta">
										<span>岗位：{col.roleTitle}</span>
										{orgLabel && <span> · 组织：{orgLabel}</span>}
									</div>
									{isOwner && col.token && col.permissionRole !== "owner" && (
										<div className="org-chip-actions">
											<button
												type="button"
												className="btn-inline"
												onClick={() => void copyCollaboratorInviteUrl(col, onNotice)}
											>
												复制邀请链接
											</button>
											{onPreviewAsCollaborator && (
												<button
													type="button"
													className="btn-inline"
													onClick={() => onPreviewAsCollaborator(col.token!)}
												>
													以此身份体验
												</button>
											)}
											<button
												type="button"
												className="btn-inline"
												onClick={() => {
													void regenerateCollaboratorToken(col.id)
														.then(async () => {
															await onRefresh();
															onNotice(`已重新生成「${col.name}」的邀请口令`);
														})
														.catch((err: unknown) =>
															onError(err instanceof Error ? err.message : String(err)),
														);
												}}
											>
												重置口令
											</button>
											<button
												type="button"
												className="btn-inline danger"
												onClick={() => {
													void deleteCollaborator(col.id)
														.then(async () => {
															await onRefresh();
															onNotice(`已移除协作成员「${col.name}」`);
														})
														.catch((err: unknown) =>
															onError(err instanceof Error ? err.message : String(err)),
														);
												}}
											>
												移除
											</button>
										</div>
									)}
								</div>
							);
						})}
					</div>
				</>
			)}

			<ModalDialog
				open={showAddCollab && isOwner}
				title="新增协同同事并生成邀请链接"
				subtitle="保存后自动生成局域网专属访问链接，同事打开即可参与讨论、提请 AI 与验收评价。"
				size="sm"
				closeDisabled={submitting}
				onClose={closeAddModal}
				footer={
					<>
						<button type="button" className="btn-pill-outline" disabled={submitting} onClick={closeAddModal}>
							取消
						</button>
						<button
							type="button"
							className="btn-pill-dark"
							disabled={!collabNameInput.trim() || submitting}
							onClick={() => void handleCreateCollaborator()}
						>
							{submitting ? "创建中…" : "保存并生成邀请"}
						</button>
					</>
				}
			>
				<div className="form-grid">
					<label className="identity-field">
						<span className="identity-field-label">同事姓名</span>
						<input
							className="input-field"
							placeholder="如：李四"
							value={collabNameInput}
							onChange={(e) => setCollabNameInput(e.target.value)}
						/>
					</label>
					<label className="identity-field">
						<span className="identity-field-label">岗位 / 分工</span>
						<input
							className="input-field"
							placeholder="如：后端研发、设计、测试"
							value={collabRoleInput}
							onChange={(e) => setCollabRoleInput(e.target.value)}
						/>
					</label>
				</div>
				{organizations.length > 0 && (
					<label className="identity-field">
						<span className="identity-field-label">所属组织（可选）</span>
						<select
							className="select-sm select-control"
							value={collabOrgInput}
							onChange={(e) => setCollabOrgInput(e.target.value)}
						>
							<option value="">默认 / 不指定</option>
							{organizations.map((org) => (
								<option key={org.id} value={org.id}>
									{org.name}
								</option>
							))}
						</select>
					</label>
				)}
			</ModalDialog>
		</section>
	);
}
