import { type HumanDecision, readHumanDecision } from "@pa/contracts/human-decision";
import { useId, useState } from "react";
import { actOnHumanDecision, type HumanDecisionAction, type MatterDto } from "../../api/matters.ts";
import type { AccountUserDto, CollaboratorDto, OrganizationMemberDto } from "../../api.ts";
import { formatClockTime } from "../../utils.ts";
import { DecisionAnswerForm } from "./DecisionAnswerForm.tsx";

export function HumanDecisionCard({
	matter,
	messageId,
	decision,
	current,
	completed,
	isRunning,
	canDispatch,
	canManage,
	canParticipate,
	accountUser,
	currentUser,
	candidates,
	requestedBy,
	sourceName,
	handledInFloatingDock = false,
}: {
	matter: MatterDto;
	messageId: string;
	decision: HumanDecision;
	current: boolean;
	completed: boolean;
	isRunning: boolean;
	canDispatch: boolean;
	canManage: boolean;
	canParticipate: boolean;
	accountUser?: AccountUserDto | null;
	currentUser?: CollaboratorDto | null;
	candidates: OrganizationMemberDto[];
	requestedBy: string;
	sourceName?: string;
	handledInFloatingDock?: boolean;
}) {
	const inputId = useId();
	const [assignee, setAssignee] = useState("");
	const [changingAssignee, setChangingAssignee] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [savedDecision, setSavedDecision] = useState<HumanDecision | null>(null);
	const active = savedDecision && savedDecision.revision >= decision.revision ? savedDecision : decision;
	const canAnswer =
		current &&
		canParticipate &&
		(active.assignedUserId
			? accountUser?.id === active.assignedUserId
			: canManage && (accountUser != null || currentUser?.permissionRole === "owner"));
	const options = active.requests.length === 1 ? (active.requests[0]?.options ?? []) : [];

	async function submit(action: HumanDecisionAction) {
		setSubmitting(true);
		setError(null);
		try {
			const result = await actOnHumanDecision(matter.id, messageId, action);
			const persisted = readHumanDecision(result.message.metadata);
			if (persisted) setSavedDecision(persisted);
			setChangingAssignee(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}

	const canAssign = active.status === "pending" && current && canManage && canParticipate && candidates.length > 0;
	const headerTitle = active.status === "answered" ? "已答复" : current ? "待你决定" : "历史澄清";
	const headerMeta = `${sourceName ? `${sourceName} 提出 · ` : ""}${requestedBy} 提请`;

	return (
		<section
			className={`human-decision-card${active.status === "answered" ? " is-answered" : ""}`}
			aria-labelledby={inputId}
		>
			<header>
				<div className="human-decision-header-main">
					<strong id={inputId}>{headerTitle}</strong>
					<span>{headerMeta}</span>
				</div>
				{canAssign && !changingAssignee && (
					<button
						type="button"
						className="btn-inline human-decision-assign-trigger"
						onClick={() => setChangingAssignee(true)}
					>
						指定答复人
					</button>
				)}
			</header>
			{active.requests.length === 1 ? (
				<div className="human-decision-body">
					<p className="human-decision-question">{active.requests[0]?.question}</p>
					{active.requests[0]?.context && <p className="human-decision-context">{active.requests[0].context}</p>}
				</div>
			) : (
				<ol className="human-decision-questions">
					{active.requests.map(({ question }, index) => (
						<li key={`${index}-${question}`}>{question}</li>
					))}
				</ol>
			)}
			{active.status === "answered" ? (
				<>
					<p className="human-decision-answer">{active.answer}</p>
					<p className="human-decision-note">
						{active.answeredBy.name} ·{" "}
						<time dateTime={active.answeredBy.at} title={new Date(active.answeredBy.at).toLocaleString()}>
							{formatClockTime(active.answeredBy.at)}
						</time>
						{active.revision > 1 ? ` · 第 ${active.revision} 版` : ""}
					</p>
					{current && !completed && (
						<p className="human-decision-note">
							{isRunning ? "答案已保存，事项正在处理。" : "答案已保存，可以继续执行。"}
						</p>
					)}
					{current && !completed && (canAnswer || canManage) && canDispatch && (
						<button
							type="button"
							className="btn-pill-dark btn-xs"
							disabled={submitting || isRunning}
							onClick={() => void submit({ action: "resume", revision: active.revision })}
						>
							继续执行
						</button>
					)}
				</>
			) : current ? (
				<>
					{!canAnswer && (
						<p className="human-decision-note">
							{active.assignedName ? `等待 ${active.assignedName} 答复` : "等待事项管理者答复"}
						</p>
					)}
					{canAnswer && handledInFloatingDock && (
						<p className="human-decision-note">请在底部输入框上方的澄清卡片中回答。</p>
					)}
					{canAnswer && !handledInFloatingDock && (
						<DecisionAnswerForm
							options={options}
							submitting={submitting}
							onAnswer={(answer) => void submit({ action: "answer", revision: active.revision, answer })}
						/>
					)}
					{canAssign && changingAssignee && (
						<form
							className="human-decision-assignee"
							onSubmit={(event) => {
								event.preventDefault();
								if (!assignee || submitting) return;
								void submit({ action: "assign", revision: active.revision, assignedUserId: assignee });
							}}
						>
							<label>
								<span>答复人</span>
								<select
									className="wechat-row-select"
									value={assignee}
									onChange={(event) => setAssignee(event.target.value)}
								>
									<option value="">选择成员</option>
									{candidates.map(({ userId, displayName, roleTitle }) => (
										<option key={userId} value={userId}>
											{displayName || roleTitle}
										</option>
									))}
								</select>
							</label>
							<button type="submit" className="btn-pill-dark btn-xs" disabled={!assignee || submitting}>
								保存
							</button>
							<button type="button" className="btn-inline" onClick={() => setChangingAssignee(false)}>
								取消
							</button>
						</form>
					)}
				</>
			) : (
				<p className="human-decision-note">此请求已失效。</p>
			)}
			{error && (
				<p className="human-decision-error" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}
