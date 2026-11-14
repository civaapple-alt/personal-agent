import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	addWorkspace,
	type BootstrapPayload,
	createMatter,
	type DeliverableDto,
	fetchBootstrap,
	fetchMatterDetail,
	type MatterDetailPayload,
	postMatterMessage,
	respondToDialog,
	stopPreview,
	submitDeliverableFeedback,
} from "./api.ts";

type NavTab = "deliverables" | "chats" | "materials";

const STATUS_LABELS: Record<string, string> = {
	open: "推进中",
	waiting_user: "待你确认",
	delivered: "已交付",
	archived: "已归档",
};

export function App() {
	const [activeTab, setActiveTab] = useState<NavTab>("deliverables");
	const [colleaguesOpen, setColleaguesOpen] = useState(true);
	const [collabOpen, setCollabOpen] = useState(false);
	const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
	const [selectedMatterId, setSelectedMatterId] = useState<string | null>(null);
	const [matterDetail, setMatterDetail] = useState<MatterDetailPayload | null>(null);
	const [selectedDeliverableId, setSelectedDeliverableId] = useState<string | null>(null);
	const [selectedMemberId, setSelectedMemberId] = useState<string>("auto");
	const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
	const [composerText, setComposerText] = useState("");
	const [feedbackText, setFeedbackText] = useState("");
	const [dialogInput, setDialogInput] = useState("");
	const [streamingDelta, setStreamingDelta] = useState("");
	const [sseConnected, setSseConnected] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [errorBanner, setErrorBanner] = useState<string | null>(null);

	const [newWsName, setNewWsName] = useState("");
	const [newWsPath, setNewWsPath] = useState("");

	const composerRef = useRef<HTMLTextAreaElement | null>(null);

	const refreshBootstrap = useCallback(async () => {
		const data = await fetchBootstrap();
		setBootstrap(data);
		setSelectedMatterId((prev) => prev ?? data.matters[0]?.id ?? null);
		setSelectedWorkspaceId((prev) => prev || data.workspaces[0]?.id || "");
		setSelectedDeliverableId((prev) => prev ?? data.deliverables[0]?.id ?? null);
	}, []);

	const refreshDetail = useCallback(async (matterId: string | null) => {
		if (!matterId) {
			setMatterDetail(null);
			return;
		}
		const detail = await fetchMatterDetail(matterId);
		setMatterDetail(detail);
	}, []);

	useEffect(() => {
		void refreshBootstrap().catch((err: unknown) => {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		});
	}, [refreshBootstrap]);

	useEffect(() => {
		void refreshDetail(selectedMatterId).catch(() => {});
	}, [selectedMatterId, refreshDetail]);

	useEffect(() => {
		const es = new EventSource("/api/events");
		es.addEventListener("connected", () => setSseConnected(true));
		es.addEventListener("text_delta", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as { matterId: string; delta: string };
			if (data.matterId === selectedMatterId) {
				setStreamingDelta((prev) => prev + data.delta);
			}
		});
		const handleSync = () => {
			setStreamingDelta("");
			void refreshBootstrap();
			if (selectedMatterId) {
				void refreshDetail(selectedMatterId);
			}
		};
		for (const evtName of [
			"matter_started",
			"matter_settled",
			"matter_failed",
			"dialog_requested",
			"dialog_resolved",
			"deliverable_updated",
			"workspace_updated",
			"preview_updated",
		]) {
			es.addEventListener(evtName, handleSync);
		}
		es.onerror = () => setSseConnected(false);
		return () => es.close();
	}, [refreshBootstrap, refreshDetail, selectedMatterId]);

	const activeDeliverable: DeliverableDto | null = useMemo(() => {
		if (!bootstrap || bootstrap.deliverables.length === 0) return null;
		return bootstrap.deliverables.find((d) => d.id === selectedDeliverableId) ?? bootstrap.deliverables[0] ?? null;
	}, [bootstrap, selectedDeliverableId]);

	const siblingVersions = useMemo(() => {
		if (!bootstrap || !activeDeliverable) return [];
		return bootstrap.deliverables
			.filter((d) => d.matterId === activeDeliverable.matterId && d.title === activeDeliverable.title)
			.sort((a, b) => a.version - b.version);
	}, [bootstrap, activeDeliverable]);

	const primaryContact = useMemo(() => {
		if (!bootstrap) return null;
		if (matterDetail?.matter.leadMemberId) {
			return bootstrap.members.find((m) => m.id === matterDetail.matter.leadMemberId) ?? null;
		}
		return bootstrap.members.find((m) => m.isPrimaryContact) ?? bootstrap.members[0] ?? null;
	}, [bootstrap, matterDetail]);

	const activeDialogs = useMemo(() => {
		if (!bootstrap) return [];
		if (selectedMatterId) {
			return bootstrap.pendingDialogs.filter((d) => d.matterId === selectedMatterId);
		}
		return bootstrap.pendingDialogs;
	}, [bootstrap, selectedMatterId]);

	const memberName = (id: string) => bootstrap?.members.find((m) => m.id === id)?.displayName ?? id;

	const handleSendPrompt = async () => {
		const text = composerText.trim();
		if (!text || submitting) return;
		setSubmitting(true);
		setErrorBanner(null);
		try {
			const preferredMemberId = selectedMemberId === "auto" ? undefined : selectedMemberId;
			if (selectedMatterId && activeTab !== "deliverables") {
				await postMatterMessage(selectedMatterId, { prompt: text, preferredMemberId });
			} else if (selectedMatterId && activeDeliverable && text.startsWith("修改")) {
				await postMatterMessage(selectedMatterId, {
					prompt: text,
					preferredMemberId,
					deliverableTitle: activeDeliverable.title,
				});
			} else {
				const created = await createMatter({
					prompt: text,
					preferredMemberId,
					workspaceId: selectedWorkspaceId || undefined,
				});
				setSelectedMatterId(created.matter.id);
			}
			setComposerText("");
			await refreshBootstrap();
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	};

	const handleDeliverableFeedback = async () => {
		if (!activeDeliverable || !feedbackText.trim()) return;
		await submitDeliverableFeedback(activeDeliverable.id, feedbackText.trim());
		setFeedbackText("");
		await refreshBootstrap();
	};

	const handleAddWorkspace = async () => {
		if (!newWsName.trim() || !newWsPath.trim()) return;
		await addWorkspace({ name: newWsName.trim(), repoPath: newWsPath.trim() });
		setNewWsName("");
		setNewWsPath("");
		await refreshBootstrap();
	};

	const linkedPreview = useMemo(() => {
		if (!bootstrap || !activeDeliverable) return null;
		return bootstrap.previews.find((p) => p.deliverableId === activeDeliverable.id) ?? null;
	}, [bootstrap, activeDeliverable]);

	const viewUrl = activeDeliverable?.serviceUrl ?? linkedPreview?.url ?? null;

	return (
		<div className="app-shell">
			<header className="topbar">
				<div className="brand">
					<span className="brand-mark">PA</span>
					<span>Personal Agent</span>
				</div>
				<div className="topbar-meta">
					<span>Pi RPC · kimi-for-coding</span>
					<span className={`pill ${sseConnected ? "live" : ""}`}>
						{sseConnected ? "实时连接中" : "连接恢复中"}
					</span>
				</div>
			</header>

			<div className="workspace-grid">
				<aside className="left-nav">
					<div className="nav-items">
						<button
							type="button"
							className={`nav-btn ${activeTab === "deliverables" ? "active" : ""}`}
							onClick={() => setActiveTab("deliverables")}
						>
							<span>交付给我</span>
							<span className="pill">{bootstrap?.deliverables.length ?? 0}</span>
						</button>
						<button
							type="button"
							className={`nav-btn ${activeTab === "chats" ? "active" : ""}`}
							onClick={() => setActiveTab("chats")}
						>
							<span>和同事聊</span>
							<span className="pill">{bootstrap?.matters.length ?? 0}</span>
						</button>
						<button
							type="button"
							className={`nav-btn ${activeTab === "materials" ? "active" : ""}`}
							onClick={() => setActiveTab("materials")}
						>
							<span>已有资料</span>
							<span className="pill">{bootstrap?.workspaces.length ?? 0}</span>
						</button>
					</div>

					<div className="colleagues-drawer">
						<button type="button" className="colleagues-toggle" onClick={() => setColleaguesOpen((v) => !v)}>
							<span>我的同事 · {bootstrap?.members.length ?? 0} 位</span>
							<span>{colleaguesOpen ? "▾" : "▸"}</span>
						</button>
						{colleaguesOpen && bootstrap && (
							<div className="colleague-list">
								{bootstrap.members.map((member) => (
									<button
										key={member.id}
										type="button"
										className={`colleague-item ${selectedMemberId === member.id ? "active" : ""}`}
										onClick={() => setSelectedMemberId(member.id)}
									>
										<div className="colleague-name">
											{member.displayName} {member.isPrimaryContact ? "· 主联系" : ""}
										</div>
										<div className="colleague-sub">{member.model}</div>
									</button>
								))}
							</div>
						)}
					</div>
				</aside>

				<main className="center-pane">
					{errorBanner && (
						<div className="approval-card" style={{ marginBottom: 14 }}>
							<strong>操作提示：</strong> {errorBanner}
						</div>
					)}

					{activeTab === "deliverables" && (
						<>
							<div className="pane-header">
								<h1>交付给我</h1>
								<p>成果和反馈留在一起，默认收起内部过程细节</p>
							</div>

							{activeDeliverable ? (
								<div className="featured-card">
									<h2 className="featured-title">{activeDeliverable.title}</h2>
									<div className="featured-meta">
										<span>{memberName(activeDeliverable.memberId)} 交付</span>
										<span>·</span>
										<span>V{activeDeliverable.version}</span>
										<span>·</span>
										<span className="pill">{activeDeliverable.type}</span>
									</div>

									<div className="deliverable-body">{activeDeliverable.contentOrPath}</div>

									<div className="actions-row">
										{viewUrl && (
											<a className="btn-primary" href={viewUrl} target="_blank" rel="noreferrer">
												打开查看 →
											</a>
										)}
										<button
											type="button"
											className="btn-secondary"
											onClick={() => {
												setSelectedMatterId(activeDeliverable.matterId);
												setComposerText(`修改「${activeDeliverable.title}」：`);
												composerRef.current?.focus();
											}}
										>
											继续修改
										</button>
									</div>

									{siblingVersions.length > 1 && (
										<div className="version-bar">
											<span>此前版本</span>
											{siblingVersions.map((ver) => (
												<button
													key={ver.id}
													type="button"
													className={`version-chip ${ver.id === activeDeliverable.id ? "active" : ""}`}
													onClick={() => setSelectedDeliverableId(ver.id)}
												>
													V{ver.version}
												</button>
											))}
										</div>
									)}

									<div className="feedback-row">
										<input
											className="input-field"
											value={feedbackText}
											onChange={(e) => setFeedbackText(e.target.value)}
											placeholder={
												activeDeliverable.feedback
													? `上次反馈：${activeDeliverable.feedback}`
													: "记录这条交付的验收反馈..."
											}
										/>
										<button type="button" className="btn-secondary" onClick={handleDeliverableFeedback}>
											保存反馈
										</button>
									</div>
								</div>
							) : (
								<div className="featured-card">
									<p style={{ margin: 0, color: "var(--text-secondary)" }}>
										暂无交付记录。你可以在右侧直接布置一件事，角色完成并达到 `agent_settled`
										后会自动归拢到这里。
									</p>
								</div>
							)}

							{bootstrap && bootstrap.deliverables.length > 1 && (
								<div className="list-section">
									{bootstrap.deliverables
										.filter((d) => d.id !== activeDeliverable?.id)
										.map((item) => (
											<button
												type="button"
												key={item.id}
												className="compact-row"
												onClick={() => {
													setSelectedDeliverableId(item.id);
													setSelectedMatterId(item.matterId);
												}}
											>
												<div>
													<div style={{ fontWeight: 600, fontSize: 14 }}>
														{item.title} · V{item.version}
													</div>
													<div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
														{memberName(item.memberId)} · {item.summary.slice(0, 80)}
													</div>
												</div>
												<span className="pill">{item.type}</span>
											</button>
										))}
								</div>
							)}

							{bootstrap && bootstrap.previews.length > 0 && (
								<div className="list-section">
									<h3 style={{ margin: "12px 0 4px", fontSize: 14 }}>独立预览服务</h3>
									{bootstrap.previews.map((prev) => (
										<div key={prev.id} className="compact-row" style={{ cursor: "default" }}>
											<div>
												<div style={{ fontWeight: 600, fontSize: 14 }}>{prev.title}</div>
												<div style={{ fontSize: 12, color: "var(--text-muted)" }}>
													{prev.url} · 状态：{prev.status}
												</div>
											</div>
											<div style={{ display: "flex", gap: 8 }}>
												{prev.status === "running" && (
													<>
														<a className="btn-secondary" href={prev.url} target="_blank" rel="noreferrer">
															打开
														</a>
														<button
															type="button"
															className="btn-secondary"
															onClick={() => void stopPreview(prev.id).then(refreshBootstrap)}
														>
															停止
														</button>
													</>
												)}
											</div>
										</div>
									))}
								</div>
							)}
						</>
					)}

					{activeTab === "chats" && (
						<>
							<div className="pane-header">
								<h1>和同事聊</h1>
								<p>按事项组织跨项目推进，不把微信式群聊信息直接堆给用户</p>
							</div>
							<div className="list-section">
								{bootstrap?.matters.map((matter) => (
									<button
										type="button"
										key={matter.id}
										className="compact-row"
										onClick={() => setSelectedMatterId(matter.id)}
										style={{
											borderColor: matter.id === selectedMatterId ? "var(--accent)" : undefined,
										}}
									>
										<div>
											<div style={{ fontWeight: 600, fontSize: 14 }}>{matter.title}</div>
											<div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
												牵头：{matter.leadMemberId ? memberName(matter.leadMemberId) : "自动路由"}
											</div>
										</div>
										<span className="pill">{STATUS_LABELS[matter.status] ?? matter.status}</span>
									</button>
								))}
							</div>
						</>
					)}

					{activeTab === "materials" && (
						<>
							<div className="pane-header">
								<h1>已有资料与工作区</h1>
								<p>仓库自身维护的信息以仓库为准；角色私有记忆与可分享模板物理隔离</p>
							</div>

							<div className="featured-card">
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
									<button type="button" className="btn-primary" onClick={handleAddWorkspace}>
										绑定
									</button>
								</div>
							</div>

							<div className="list-section">
								{bootstrap?.workspaces.map((ws) => (
									<div key={ws.id} className="compact-row" style={{ cursor: "default" }}>
										<div>
											<div style={{ fontWeight: 600, fontSize: 14 }}>
												{ws.name} ({ws.defaultBranch})
											</div>
											<div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
												{ws.repoPath}
											</div>
										</div>
									</div>
								))}
							</div>
						</>
					)}
				</main>

				<aside className="right-pane">
					<div className="contact-header">
						<div>
							<div className="contact-title">
								{primaryContact ? `${primaryContact.displayName} · ${primaryContact.roleTitle}` : "主要联系人"}
							</div>
							<div className="contact-sub">
								{matterDetail ? `当前事项：${matterDetail.matter.title}` : "新事项将自动按事找人"}
							</div>
						</div>
						<select
							className="select-sm"
							value={selectedMemberId}
							onChange={(e) => setSelectedMemberId(e.target.value)}
						>
							<option value="auto">按事找人</option>
							{bootstrap?.members.map((m) => (
								<option key={m.id} value={m.id}>
									指定：{m.displayName}
								</option>
							))}
						</select>
					</div>

					<div className="messages-scroll">
						{activeDialogs.map((dlg) => (
							<div key={dlg.id} className="approval-card">
								<h4>
									{dlg.memberName} 请求确认：{dlg.request.title}
								</h4>
								{dlg.request.message && <p style={{ margin: "0 0 8px" }}>{dlg.request.message}</p>}
								{dlg.request.method === "confirm" && (
									<div style={{ display: "flex", gap: 8 }}>
										<button
											type="button"
											className="btn-primary"
											onClick={() => void respondToDialog(dlg.id, { confirmed: true })}
										>
											允许继续
										</button>
										<button
											type="button"
											className="btn-secondary"
											onClick={() => void respondToDialog(dlg.id, { confirmed: false })}
										>
											拒绝
										</button>
									</div>
								)}
								{dlg.request.method === "select" && dlg.request.options && (
									<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
										{dlg.request.options.map((opt) => (
											<button
												key={opt}
												type="button"
												className="btn-secondary"
												onClick={() => void respondToDialog(dlg.id, { value: opt })}
											>
												{opt}
											</button>
										))}
									</div>
								)}
								{(dlg.request.method === "input" || dlg.request.method === "editor") && (
									<div style={{ display: "flex", gap: 6 }}>
										<input
											className="input-field"
											value={dialogInput}
											onChange={(e) => setDialogInput(e.target.value)}
											placeholder={dlg.request.placeholder ?? "输入答复..."}
										/>
										<button
											type="button"
											className="btn-primary"
											onClick={() => {
												void respondToDialog(dlg.id, { value: dialogInput });
												setDialogInput("");
											}}
										>
											提交
										</button>
									</div>
								)}
							</div>
						))}

						{matterDetail?.userMessages.map((msg) => (
							<div key={msg.id} className={`bubble ${msg.senderType === "user" ? "user" : "member"}`}>
								<div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
									{msg.senderType === "user" ? "我" : memberName(msg.senderId)}
								</div>
								{msg.content}
							</div>
						))}

						{streamingDelta && (
							<div className="bubble member">
								<div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>正在生成...</div>
								{streamingDelta}
							</div>
						)}
					</div>

					<div className="collab-collapse">
						<button type="button" className="collab-toggle" onClick={() => setCollabOpen((v) => !v)}>
							协作对话与过程通知（
							{(matterDetail?.internalCollabMessages.length ?? 0) + (matterDetail?.noticeMessages.length ?? 0)}）{" "}
							{collabOpen ? "▾" : "▸"}
						</button>
						{collabOpen && matterDetail && (
							<div className="collab-log">
								{[...matterDetail.internalCollabMessages, ...matterDetail.noticeMessages].map((entry) => (
									<div key={entry.id}>
										<strong>[{entry.channel}]</strong> {memberName(entry.senderId)}：{entry.content}
									</div>
								))}
							</div>
						)}
					</div>

					<div className="composer">
						<div className="composer-controls">
							<select
								className="select-sm"
								value={selectedWorkspaceId}
								onChange={(e) => setSelectedWorkspaceId(e.target.value)}
							>
								<option value="">不绑定仓库</option>
								{bootstrap?.workspaces.map((ws) => (
									<option key={ws.id} value={ws.id}>
										仓库：{ws.name}
									</option>
								))}
							</select>
							<button
								type="button"
								className="btn-secondary"
								style={{ padding: "4px 10px", fontSize: 12 }}
								onClick={() => setSelectedMatterId(null)}
							>
								新事项
							</button>
						</div>
						<div className="composer-row">
							<textarea
								ref={composerRef}
								rows={2}
								className="composer-input"
								value={composerText}
								onChange={(e) => setComposerText(e.target.value)}
								placeholder="提修改意见，或交给我另一件事..."
							/>
							<button
								type="button"
								className="btn-primary"
								disabled={submitting}
								onClick={() => void handleSendPrompt()}
							>
								{submitting ? "派发中" : "发送"}
							</button>
						</div>
					</div>
				</aside>
			</div>
		</div>
	);
}
