import { useState } from "react";
import {
	createOrganization,
	type OrganizationDto,
	setDefaultOrganization,
	updateOrganization,
	type WorkspaceDto,
} from "../../api.ts";
import { ModalDialog } from "../ModalDialog.tsx";

interface OrganizationsSectionProps {
	isOwner: boolean;
	organizations: OrganizationDto[];
	workspaces: WorkspaceDto[];
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Manages organization profiles, default org selection, Git email domain hints, and workspace groupings. */
export function OrganizationsSection({
	isOwner,
	organizations,
	workspaces,
	onRefresh,
	onNotice,
	onError,
}: OrganizationsSectionProps) {
	const [expanded, setExpanded] = useState(false);
	const [showOrgForm, setShowOrgForm] = useState(false);
	const [editingOrgId, setEditingOrgId] = useState<string | null>(null);
	const [orgNameInput, setOrgNameInput] = useState("");
	const [orgDomainInput, setOrgDomainInput] = useState("");
	const [orgDescInput, setOrgDescInput] = useState("");
	const [saving, setSaving] = useState(false);

	const openCreateOrgForm = () => {
		setEditingOrgId(null);
		setOrgNameInput("");
		setOrgDomainInput("");
		setOrgDescInput("");
		setShowOrgForm(true);
	};

	const openEditOrgForm = (org: OrganizationDto) => {
		setEditingOrgId(org.id);
		setOrgNameInput(org.name);
		setOrgDomainInput(org.gitEmailDomain);
		setOrgDescInput(org.description);
		setShowOrgForm(true);
	};

	const closeOrgModal = () => {
		if (saving) return;
		setShowOrgForm(false);
		setEditingOrgId(null);
	};

	const handleSaveOrg = async () => {
		if (!orgNameInput.trim() || saving) return;
		setSaving(true);
		try {
			if (editingOrgId) {
				await updateOrganization(editingOrgId, {
					name: orgNameInput.trim(),
					gitEmailDomain: orgDomainInput.trim(),
					description: orgDescInput.trim(),
				});
				onNotice(`组织「${orgNameInput.trim()}」已更新`);
			} else {
				await createOrganization({
					name: orgNameInput.trim(),
					gitEmailDomain: orgDomainInput.trim(),
					description: orgDescInput.trim(),
				});
				onNotice(`已创建组织「${orgNameInput.trim()}」`);
			}
			setShowOrgForm(false);
			setEditingOrgId(null);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const handleSetDefaultOrg = async (org: OrganizationDto) => {
		try {
			await setDefaultOrganization(org.id);
			onNotice(`已将「${org.name}」设为默认组织，新创建的仓库与组织记忆将默认归入此组织`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	const defaultOrg = organizations.find((o) => o.isDefault) ?? organizations[0] ?? null;

	return (
		<section className="org-strip-card">
			<div className="ui-section-head team-admin-head">
				<div className="team-admin-summary">
					<h2 className="ui-section-title">组织身份与多仓库（{organizations.length}）</h2>
					<span className="team-admin-meta">
						{defaultOrg ? `默认「${defaultOrg.name}」` : "尚未建立组织，新建仓库时将自动创建"}
					</span>
				</div>
				<div className="ui-row-actions">
					{isOwner && (
						<button type="button" className="btn-pill-outline btn-xs" onClick={openCreateOrgForm}>
							+ 新建组织
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
						同一支全局团队成员跨组织与多仓库工作；同组织仓库共享「组织记忆」与 Git 邮箱域名。
					</p>
					{organizations.length === 0 ? (
						<div className="muted-hint">
							尚未建立组织（新建仓库时会自动创建「默认组织」）。成员按「角色 Author + 仓库真实用户
							Committer」双署名提交 Git；创建组织并在「资料与仓库」绑定后，同组织仓库共享组织记忆。
						</div>
					) : (
						<div className="org-chip-list">
							{organizations.map((org) => {
								const boundWs = workspaces.filter((ws) => ws.orgId === org.id);
								return (
									<div key={org.id} className="org-chip-card">
										<div className="org-chip-head">
											<div className="ui-inline-head">
												<strong className="ui-chip-title">{org.name}</strong>
												{org.isDefault && <span className="pill live">默认组织</span>}
											</div>
											<div className="ui-row-actions">
												{!org.isDefault && (
													<button
														type="button"
														className="btn-inline btn-xs"
														onClick={() => void handleSetDefaultOrg(org)}
													>
														设为默认
													</button>
												)}
												<button
													type="button"
													className="btn-inline btn-xs"
													onClick={() => openEditOrgForm(org)}
												>
													编辑
												</button>
											</div>
										</div>
										<div className="org-chip-meta">
											{org.gitEmailDomain ? `Git 域名：@${org.gitEmailDomain} · ` : ""}
											{boundWs.length > 0
												? `已关联仓库：${boundWs.map((w) => w.name).join("、")}`
												: "尚未关联仓库（可在「资料与仓库」选择归属）"}
										</div>
										{org.description && <div className="org-chip-meta">{org.description}</div>}
									</div>
								);
							})}
						</div>
					)}
				</>
			)}

			<ModalDialog
				open={showOrgForm}
				title={editingOrgId ? "编辑组织身份" : "新建组织身份"}
				subtitle="归属同一组织的工作区会共享「组织记忆」与默认 Git 邮箱域名。"
				size="sm"
				closeDisabled={saving}
				onClose={closeOrgModal}
				footer={
					<>
						<button type="button" className="btn-pill-outline" disabled={saving} onClick={closeOrgModal}>
							取消
						</button>
						<button
							type="button"
							className="btn-pill-dark"
							disabled={!orgNameInput.trim() || saving}
							onClick={() => void handleSaveOrg()}
						>
							{saving ? "保存中..." : "保存组织"}
						</button>
					</>
				}
			>
				<div className="form-grid">
					<label className="identity-field">
						<span className="identity-field-label">组织名称</span>
						<input
							className="input-field"
							aria-label="组织名称"
							placeholder="如：Acme Engineering"
							value={orgNameInput}
							onChange={(e) => setOrgNameInput(e.target.value)}
						/>
					</label>
					<label className="identity-field">
						<span className="identity-field-label">默认 Git 邮箱域名（可选）</span>
						<input
							className="input-field"
							aria-label="组织 Git 邮箱域名"
							placeholder="如：acme.dev"
							value={orgDomainInput}
							onChange={(e) => setOrgDomainInput(e.target.value)}
						/>
					</label>
				</div>
				<label className="identity-field">
					<span className="identity-field-label">组织背景与共同准则（可选，执行时自动注入上下文）</span>
					<textarea
						rows={3}
						className="composer-input"
						aria-label="组织简介"
						placeholder="简要描述组织规范、协作边界或业务背景"
						value={orgDescInput}
						onChange={(e) => setOrgDescInput(e.target.value)}
					/>
				</label>
			</ModalDialog>
		</section>
	);
}
