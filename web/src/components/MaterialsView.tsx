import { useState } from "react";
import { addWorkspace, type WorkspaceDto } from "../api.ts";

interface MaterialsViewProps {
	workspaces: WorkspaceDto[];
	selectedWorkspaceId: string;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
	onUseWorkspace: (workspaceId: string) => void;
}

export function MaterialsView({
	workspaces,
	selectedWorkspaceId,
	onRefresh,
	onNotice,
	onError,
	onUseWorkspace,
}: MaterialsViewProps) {
	const [newWsName, setNewWsName] = useState("");
	const [newWsPath, setNewWsPath] = useState("");

	const handleAddWorkspace = async () => {
		if (!newWsName.trim() || !newWsPath.trim()) return;
		try {
			await addWorkspace({ name: newWsName.trim(), repoPath: newWsPath.trim() });
			setNewWsName("");
			setNewWsPath("");
			onNotice("项目工作区已绑定");
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
					<p>仓库自身维护的信息以仓库为准；角色私有记忆与可分享模板物理隔离</p>
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
						<button type="button" className="btn-pill-dark" onClick={() => void handleAddWorkspace()}>
							绑定
						</button>
					</div>
				</div>

				<div className="list-section">
					{workspaces.map((ws) => (
						<div key={ws.id} className="compact-row" style={{ cursor: "default" }}>
							<div>
								<div style={{ fontWeight: 600, fontSize: 14 }}>
									{ws.name} ({ws.defaultBranch})
								</div>
								<div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{ws.repoPath}</div>
							</div>
							<button type="button" className="btn-pill-outline btn-xs" onClick={() => onUseWorkspace(ws.id)}>
								{selectedWorkspaceId === ws.id ? "当前已选 · 新建任务 →" : "在此仓库派活 →"}
							</button>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
