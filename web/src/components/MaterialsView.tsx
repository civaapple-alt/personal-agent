import { useState } from "react";
import { addWorkspace, type OrganizationDto, updateWorkspace, type WorkspaceDto } from "../api.ts";
import { copyTextToClipboard } from "../clipboard.ts";

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
			<div className="subpage-inner wide">
				<div className="pane-header">
					<h1>已有资料与项目仓库</h1>
					<p>仓库自身维护的信息以仓库为准；归属同一组织的仓库可共享组织记忆并继承组织 Git 邮箱域名</p>
				</div>

				<div className="ui-sections-stack">
					<section className="ui-card">
						<h2 className="ui-card-title">登记项目 Git 工作区</h2>
						<div className="workspace-bind-grid">
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
								className="select-sm select-control"
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
					</section>

					<section className="ui-section">
						<div className="ui-section-head">
							<div>
								<h2 className="ui-section-title">已登记工作区（{workspaces.length}）</h2>
								<p className="ui-section-desc">切换仓库所属组织即可共享对应「组织记忆」与邮箱域名</p>
							</div>
						</div>
						{workspaces.length === 0 ? (
							<div className="ui-card">
								<p className="ui-empty-note compact">暂无已登记仓库，可在上方表单添加本地 Git 仓库。</p>
							</div>
						) : (
							workspaces.map((ws) => {
								const org = ws.orgId ? organizations.find((o) => o.id === ws.orgId) : null;
								const isActive = selectedWorkspaceId === ws.id;
								return (
									<div key={ws.id} className={`compact-row static${isActive ? " is-active" : ""}`}>
										<div className="ui-row-main">
											<div className="ui-row-title">
												<span>
													{ws.name} ({ws.defaultBranch})
												</span>
												{org && <span className="pill org-pill">组织：{org.name}</span>}
												{isActive && <span className="pill is-active">当前已选</span>}
											</div>
											<div className="ui-row-sub">
												{ws.repoPath}
												{ws.repoGitUser
													? ` · Git Committer：${ws.repoGitUser.name} <${ws.repoGitUser.email}>`
													: ""}
											</div>
										</div>
										<div className="ui-row-actions">
											<button
												type="button"
												className="btn-inline"
												onClick={() => void copyTextToClipboard(ws.repoPath, "仓库路径", onNotice)}
											>
												复制路径
											</button>
											{organizations.length > 0 && (
												<select
													className="select-sm select-control"
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
												className={`${isActive ? "btn-pill-dark" : "btn-pill-outline"} btn-xs`}
												onClick={() => onUseWorkspace(ws.id)}
											>
												{isActive ? "当前已选 · 新建任务 →" : "在此仓库派活 →"}
											</button>
										</div>
									</div>
								);
							})
						)}
					</section>
				</div>
			</div>
		</div>
	);
}
