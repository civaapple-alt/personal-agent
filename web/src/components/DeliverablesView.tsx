import type { BootstrapPayload, DeliverableDto } from "../api.ts";
import { DeliverableCard } from "./DeliverableCard.tsx";

interface DeliverablesViewProps {
	bootstrap: BootstrapPayload | null;
	activeDeliverable: DeliverableDto | null;
	filteredDeliverables: DeliverableDto[];
	siblingVersions: DeliverableDto[];
	previewUrlFor: (deliverable: DeliverableDto | null) => string | null;
	memberName: (id: string) => string;
	workspaceName: (id: string | null) => string | null;
	onSubmitFeedback: (deliverableId: string, feedback: string) => Promise<void>;
	onSaveMemory: (
		deliverable: DeliverableDto,
		content: string,
		scope: "role_general" | "project_private",
	) => Promise<void>;
	onStopPreview: (previewId: string) => Promise<void>;
	onSelectDeliverable: (deliverableId: string, matterId?: string) => void;
	onRequestRevision: (deliverable: DeliverableDto) => void;
	onNewTask: () => void;
}

export function DeliverablesView({
	bootstrap,
	activeDeliverable,
	filteredDeliverables,
	siblingVersions,
	previewUrlFor,
	memberName,
	workspaceName,
	onSubmitFeedback,
	onSaveMemory,
	onStopPreview,
	onSelectDeliverable,
	onRequestRevision,
	onNewTask,
}: DeliverablesViewProps) {
	return (
		<div className="subpage-scroll">
			<div className="subpage-inner">
				<div className="pane-header-row">
					<div className="pane-header">
						<h1>交付成果库</h1>
						<p>按版本归拢完成的成果与反馈，也可随时回到对话继续修改</p>
					</div>
					<button type="button" className="btn-pill-dark" onClick={onNewTask}>
						+ 布置新任务
					</button>
				</div>

				{activeDeliverable ? (
					<DeliverableCard
						deliverable={activeDeliverable}
						siblingVersions={siblingVersions}
						memberName={memberName(activeDeliverable.memberId)}
						workspaceName={workspaceName(
							bootstrap?.matters.find((m) => m.id === activeDeliverable.matterId)?.workspaceId ?? null,
						)}
						viewUrl={previewUrlFor(activeDeliverable)}
						onSubmitFeedback={onSubmitFeedback}
						onSelectVersion={(id) => onSelectDeliverable(id)}
						onRequestRevision={() => onRequestRevision(activeDeliverable)}
						onSaveMemory={(content, scope) => onSaveMemory(activeDeliverable, content, scope)}
					/>
				) : (
					<div className="deliverable-card">
						<p style={{ margin: 0, color: "var(--text-secondary)" }}>
							暂无交付记录。回到对话工作台发送需求或点选示范任务，完成后成果会自动归拢到这里。
						</p>
					</div>
				)}

				{filteredDeliverables.length > 1 && (
					<div className="list-section">
						{filteredDeliverables
							.filter((d) => d.id !== activeDeliverable?.id)
							.map((item) => (
								<button
									type="button"
									key={item.id}
									className="compact-row"
									onClick={() => onSelectDeliverable(item.id, item.matterId)}
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
												onClick={() => void onStopPreview(prev.id)}
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
			</div>
		</div>
	);
}
