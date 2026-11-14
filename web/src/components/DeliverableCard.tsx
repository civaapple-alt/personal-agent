import { useState } from "react";
import type { DeliverableDto } from "../api.ts";
import { MarkdownView } from "../MarkdownView.tsx";
import { formatClockTime } from "../utils.ts";

interface DeliverableCardProps {
	deliverable: DeliverableDto;
	siblingVersions: DeliverableDto[];
	memberName: string;
	workspaceName: string | null;
	viewUrl: string | null;
	onSubmitFeedback: (deliverableId: string, feedback: string) => Promise<void>;
	onSelectVersion: (deliverableId: string) => void;
	onRequestRevision: () => void;
	onOpenMatterChat?: () => void;
	onSaveMemory: (content: string, scope: "role_general" | "project_private") => Promise<void>;
	compact?: boolean;
}

export function DeliverableCard(props: DeliverableCardProps) {
	const [memoryOpen, setMemoryOpen] = useState(false);
	const [memoryText, setMemoryText] = useState("");
	const [memoryScope, setMemoryScope] = useState<"role_general" | "project_private">("role_general");
	const [feedbackText, setFeedbackText] = useState("");

	const handleFeedbackSubmit = () => {
		const trimmed = feedbackText.trim();
		if (!trimmed) return;
		void props.onSubmitFeedback(props.deliverable.id, trimmed).then(() => {
			setFeedbackText("");
		});
	};

	return (
		<div className={`deliverable-card ${props.compact ? "compact" : ""}`}>
			<div className="success-banner">
				<span>✓ 已完成交付 · 由【{props.memberName}】产出</span>
				<div className="success-tags">
					{props.workspaceName && <span className="pill">仓库：{props.workspaceName}</span>}
					<span className="pill">{formatClockTime(props.deliverable.createdAt)}</span>
				</div>
			</div>

			<div className="deliverable-head-row">
				<div>
					<h3 className="deliverable-title">{props.deliverable.title}</h3>
					<div className="featured-meta">
						<span>{props.memberName}</span>
						<span>·</span>
						<span>V{props.deliverable.version}</span>
						<span>·</span>
						<span className="pill">{props.deliverable.type}</span>
					</div>
				</div>
				{props.siblingVersions.length > 1 && (
					<div className="version-bar" style={{ marginTop: 0 }}>
						{props.siblingVersions.map((ver) => (
							<button
								key={ver.id}
								type="button"
								className={`version-chip ${ver.id === props.deliverable.id ? "active" : ""}`}
								onClick={() => props.onSelectVersion(ver.id)}
							>
								V{ver.version}
							</button>
						))}
					</div>
				)}
			</div>

			<div className="deliverable-body">
				<MarkdownView content={props.deliverable.contentOrPath} />
			</div>

			<div className="actions-row">
				{props.viewUrl && (
					<a className="btn-pill-dark" href={props.viewUrl} target="_blank" rel="noreferrer">
						打开查看 →
					</a>
				)}
				<button type="button" className="btn-pill-outline" onClick={props.onRequestRevision}>
					继续修改
				</button>
				{props.onOpenMatterChat && (
					<button type="button" className="btn-pill-outline" onClick={props.onOpenMatterChat}>
						查看原对话
					</button>
				)}
				<button
					type="button"
					className="btn-pill-outline"
					onClick={() => {
						setMemoryOpen((prev) => !prev);
						if (!memoryText) {
							setMemoryText(`关于「${props.deliverable.title}」的做法总结：${props.deliverable.summary}`);
						}
					}}
				>
					{memoryOpen ? "收起经验沉淀" : "沉淀为角色经验"}
				</button>
			</div>

			{memoryOpen && (
				<div className="memory-draft-box">
					<div className="memory-draft-head">
						<strong>沉淀为「{props.memberName}」的工作习惯</strong>
						<select
							className="select-sm"
							value={memoryScope}
							onChange={(e) => setMemoryScope(e.target.value as "role_general" | "project_private")}
						>
							<option value="role_general">角色通用经验（跨项目可用）</option>
							<option value="project_private">当前项目规范（仅当前仓库生效）</option>
						</select>
					</div>
					<div className="feedback-row">
						<input
							className="input-field"
							value={memoryText}
							onChange={(e) => setMemoryText(e.target.value)}
							placeholder="例如：交付工程文档时优先列出可直接执行的启动命令..."
						/>
						<button
							type="button"
							className="btn-primary btn-sm"
							onClick={() => {
								if (!memoryText.trim()) return;
								void props.onSaveMemory(memoryText.trim(), memoryScope).then(() => {
									setMemoryText("");
									setMemoryOpen(false);
								});
							}}
						>
							保存经验
						</button>
					</div>
				</div>
			)}

			<div className="feedback-row">
				<input
					className="input-field"
					value={feedbackText}
					onChange={(e) => setFeedbackText(e.target.value)}
					placeholder={
						props.deliverable.feedback ? `上次反馈：${props.deliverable.feedback}` : "记录这条交付的验收反馈..."
					}
				/>
				<button type="button" className="btn-secondary btn-sm" onClick={handleFeedbackSubmit}>
					保存反馈
				</button>
			</div>
		</div>
	);
}
