import { useState } from "react";
import {
	type CollaboratorDto,
	createCollaborator,
	deleteCollaborator,
	type OrganizationDto,
	regenerateCollaboratorToken,
} from "../../api.ts";
import { copyCollaboratorInviteUrl } from "../../clipboard.ts";

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

/** Manages human collaborators and LAN invitation links for restricted multi-human collaboration. */
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
	const [showAddCollab, setShowAddCollab] = useState(false);
	const [collabNameInput, setCollabNameInput] = useState("");
	const [collabRoleInput, setCollabRoleInput] = useState("");
	const [collabOrgInput, setCollabOrgInput] = useState("");

	return (
		<div className="org-strip-card">
			<div className="banner-row">
				<div>
					<strong className="ui-inline-head-title">团队同事与邀请</strong>
					<span className="ui-inline-sub">
						所有者掌管代码执行、仓库切换与角色设置；同事通过专属邀请链接加入同一房间讨论、提请 AI 与验收评价
					</span>
				</div>
				<div className="ui-row-actions">
					{!isOwner && onRestoreOwner && (
						<button type="button" className="btn-pill-outline btn-xs" onClick={onRestoreOwner}>
							恢复所有者身份
						</button>
					)}
					{isOwner && (
						<button
							type="button"
							className="btn-pill-outline btn-xs"
							onClick={() => setShowAddCollab((prev) => !prev)}
						>
							+ 新增邀请同事
						</button>
					)}
				</div>
			</div>

			<div className="collab-humans-list">
				{collaborators.map((col) => {
					const isSelf = currentUser?.id === col.id;
					const orgLabel = col.orgId ? (organizations.find((o) => o.id === col.orgId)?.name ?? col.orgId) : null;
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
								<div className="ui-row-actions tight">
									{isOwner && col.token && col.permissionRole !== "owner" && (
										<>
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
										</>
									)}
								</div>
							</div>
							<div className="org-chip-meta">
								<span>岗位：{col.roleTitle}</span>
								{orgLabel && <span> · 组织：{orgLabel}</span>}
							</div>
						</div>
					);
				})}
			</div>

			{showAddCollab && isOwner && (
				<div className="org-inline-form">
					<div className="ui-chip-title">新增协同同事并生成邀请链接</div>
					<div className="form-grid">
						<input
							className="input-field"
							placeholder="同事姓名（如：李四）"
							value={collabNameInput}
							onChange={(e) => setCollabNameInput(e.target.value)}
						/>
						<input
							className="input-field"
							placeholder="岗位/分工（如：后端研发、设计、测试）"
							value={collabRoleInput}
							onChange={(e) => setCollabRoleInput(e.target.value)}
						/>
					</div>
					<div className="actions-row tight">
						{organizations.length > 0 && (
							<select
								className="select-pill"
								value={collabOrgInput}
								onChange={(e) => setCollabOrgInput(e.target.value)}
							>
								<option value="">组织：默认 / 不指定</option>
								{organizations.map((org) => (
									<option key={org.id} value={org.id}>
										组织：{org.name}
									</option>
								))}
							</select>
						)}
						<button
							type="button"
							className="btn-pill-dark"
							disabled={!collabNameInput.trim()}
							onClick={() => {
								void createCollaborator({
									name: collabNameInput.trim(),
									roleTitle: collabRoleInput.trim() || "协同同事",
									orgId: collabOrgInput || null,
								})
									.then(async (res) => {
										setCollabNameInput("");
										setCollabRoleInput("");
										setCollabOrgInput("");
										setShowAddCollab(false);
										await onRefresh();
										onNotice(`已创建同事「${res.collaborator.name}」并生成专属邀请链接`);
									})
									.catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
							}}
						>
							保存并生成邀请
						</button>
						<button type="button" className="btn-pill-outline" onClick={() => setShowAddCollab(false)}>
							取消
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
