import { useState } from "react";
import { addWorkspace, type OrganizationDto, updateWorkspace, type WorkspaceDto } from "../api.ts";

interface MaterialsViewProps {
	workspaces: WorkspaceDto[];
	organizations: OrganizationDto[];
	selectedWorkspaceId: string;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
	onUseWorkspace: (workspaceId: string) => void;
}

export function MaterialsView({
	workspaces,
	organizations,
	selectedWorkspaceId,
	onRefresh,
	onNotice,
	onError,
	onUseWorkspace,
}: MaterialsViewProps) {
	const defaultOrganization = organizations.find((o) => o.isDefault) ?? organizations[0] ?? null;
	const [newWsName, setNewWsName] = useState("");
	const [newWsPath, setNewWsPath] = useState("");
	const [newWsOrgChoice, setNewWsOrgChoice] = useState<string>("");

	const resolvedNewOrgId =
		newWsOrgChoice === "__standalone__" ? null : newWsOrgChoice || defaultOrganization?.id || null;

	const handleAddWorkspace = async () => {
		if (!newWsName.trim() || !newWsPath.trim()) return;
		try {
			await addWorkspace({
				name: newWsName.trim(),
				repoPath: newWsPath.trim(),
				orgId: newWsOrgChoice === "__standalone__" ? null : newWsOrgChoice || undefined,
			});
			setNewWsName("");
			setNewWsPath("");
			onNotice("项目工作区已绑定");
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleChangeWorkspaceOrg = async (workspaceId: string, orgId: string) => {
		try {
			await updateWorkspace(workspaceId, { orgId: orgId || null });
			onNotice(orgId ? "仓库所属组织已更新，同组织仓库将共享组织级经验与记忆" : "已取消该仓库的组织归属");
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<div className="subpage-scroll">
			<div className="subpage-inner">
				<div className="pane-header">
					<h1>已有资料与项目仓库</h1>
					<p>仓库自身维护的信息以仓库为准；归属同一组织的仓库可共享组织记忆并继承组织 Git 邮箱域名</p>
				</div>

				<div className="deliverable-card">
					<h3 style={{ margin: "0 0 10px", fontSize: 15 }}>登记项目 Git 工作区</h3>
					<div className="feedback-row">
						<input
							className="input-field"
							placeholder="项目名称（如 order-service）"
							value={newWsName}
							onChange={(e) => setNewWsName(e.target.value)}
						/>
						<input
							className="input-field"
							placeholder="本地仓库绝对路径"
							value={newWsPath}
							onChange={(e) => setNewWsPath(e.target.value)}
						/>
						<select
							className="select-sm"
							aria-label="新仓库所属组织"
							value={newWsOrgChoice === "__standalone__" ? "__standalone__" : (resolvedNewOrgId ?? "")}
							onChange={(e) => setNewWsOrgChoice(e.target.value)}
						>
							{organizations.length === 0 ? (
								<option value="">自动归入默认组织</option>
							) : (
								organizations.map((org) => (
									<option key={org.id} value={org.id}>
										组织：{org.name}
										{org.isDefault ? "（默认）" : ""}
									</option>
								))
							)}
							<option value="__standalone__">不归属组织（独立仓库）</option>
						</select>
						<button type="button" className="btn-pill-dark" onClick={() => void handleAddWorkspace()}>
							绑定
						</button>
					</div>
				</div>

				<div className="list-section">
					{workspaces.map((ws) => {
						const org = ws.orgId ? organizations.find((o) => o.id === ws.orgId) : null;
						return (
							<div key={ws.id} className="compact-row" style={{ cursor: "default" }}>
								<div>
									<div
										style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}
									>
										<span>
											{ws.name} ({ws.defaultBranch})
										</span>
										{org && <span className="pill org-pill">组织：{org.name}</span>}
									</div>
									<div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
										{ws.repoPath}
										{ws.repoGitUser
											? ` · Git Committer：${ws.repoGitUser.name} <${ws.repoGitUser.email}>`
											: ""}
									</div>
								</div>
								<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
									{organizations.length > 0 && (
										<select
											className="select-sm"
											aria-label={`设置 ${ws.name} 的所属组织`}
											value={ws.orgId ?? ""}
											onChange={(e) => void handleChangeWorkspaceOrg(ws.id, e.target.value)}
										>
											<option value="">独立仓库（无组织）</option>
											{organizations.map((item) => (
												<option key={item.id} value={item.id}>
													组织：{item.name}
												</option>
											))}
										</select>
									)}
									<button
										type="button"
										className="btn-pill-outline btn-xs"
										onClick={() => onUseWorkspace(ws.id)}
									>
										{selectedWorkspaceId === ws.id ? "当前已选 · 新建任务 →" : "在此仓库派活 →"}
									</button>
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
