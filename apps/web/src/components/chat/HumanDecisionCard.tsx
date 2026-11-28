import { type HumanDecision, readHumanDecision } from "@pa/contracts/human-decision";
import { useId, useState } from "react";
import { actOnHumanDecision, type HumanDecisionAction, type MatterDto } from "../../api/matters.ts";
import type { AccountUserDto, CollaboratorDto, OrganizationMemberDto } from "../../api.ts";
import { Banner, Button, Select } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";
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
	const assigneeSelectId = useId();
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
			className={cn(
				"w-full max-w-[42rem] grid gap-2.5 p-3.5 mt-2 border border-line rounded-xl text-sm text-ink",
				active.status === "answered" ? "bg-sidebar" : "bg-surface",
			)}
			aria-labelledby={inputId}
		>
			<header className="flex flex-wrap items-center justify-between gap-2.5">
				<div className="flex flex-wrap items-center gap-2">
					<strong id={inputId} className="font-semibold text-ink">
						{headerTitle}
					</strong>
					<span className="text-xs text-ink-secondary">{headerMeta}</span>
				</div>
				{canAssign && !changingAssignee && (
					<Button variant="inline" size="xs" onClick={() => setChangingAssignee(true)}>
						指定答复人
					</Button>
				)}
			</header>
			{active.requests.length === 1 ? (
				<div className="grid gap-1">
					<p className="m-0 font-semibold text-ink break-words">{active.requests[0]?.question}</p>
					{active.requests[0]?.context && (
						<p className="m-0 text-xs text-ink-secondary leading-normal break-words">
							{active.requests[0].context}
						</p>
					)}
				</div>
			) : (
				<ol className="m-0 pl-5 grid gap-1.5">
					{active.requests.map(({ question, context, options: reqOptions }, index) => (
						<li key={`${index}-${question}`}>
							<div className="font-medium text-ink">{question}</div>
							{context && <div className="text-xs text-ink-secondary leading-normal">{context}</div>}
							{reqOptions && reqOptions.length > 0 && (
								<div className="text-xs text-ink-secondary">选项：{reqOptions.join(" / ")}</div>
							)}
						</li>
					))}
				</ol>
			)}
			{active.status === "answered" ? (
				<>
					<p className="m-0 whitespace-pre-wrap text-ink break-words">{active.answer}</p>
					<p className="m-0 text-xs text-ink-secondary break-words">
						{active.answeredBy.name} ·{" "}
						<time dateTime={active.answeredBy.at} title={new Date(active.answeredBy.at).toLocaleString()}>
							{formatClockTime(active.answeredBy.at)}
						</time>
						{active.revision > 1 ? ` · 第 ${active.revision} 版` : ""}
					</p>
					{current && !completed && (
						<p className="m-0 text-xs text-ink-secondary">
							{isRunning ? "答案已保存，事项正在处理。" : "答案已保存，可以继续执行。"}
						</p>
					)}
					{current && !completed && (canAnswer || canManage) && canDispatch && (
						<div className="flex items-center">
							<Button
								variant="primary"
								size="xs"
								disabled={submitting || isRunning}
								onClick={() => void submit({ action: "resume", revision: active.revision })}
							>
								继续执行
							</Button>
						</div>
					)}
				</>
			) : current ? (
				<>
					{!canAnswer && (
						<p className="m-0 text-xs text-ink-secondary">
							{active.assignedName ? `等待 ${active.assignedName} 答复` : "等待事项管理者答复"}
						</p>
					)}
					{canAnswer && handledInFloatingDock && (
						<p className="m-0 text-xs text-ink-secondary">请在底部输入框上方的澄清卡片中回答。</p>
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
							className="flex flex-wrap items-center justify-between gap-2.5"
							onSubmit={(event) => {
								event.preventDefault();
								if (!assignee || submitting) return;
								void submit({ action: "assign", revision: active.revision, assignedUserId: assignee });
							}}
						>
							<label
								htmlFor={assigneeSelectId}
								className="flex items-center gap-1.5 flex-wrap text-xs text-ink-secondary"
							>
								<span>答复人</span>
								<Select
									id={assigneeSelectId}
									size="sm"
									className="w-auto"
									value={assignee}
									onChange={(event) => setAssignee(event.target.value)}
								>
									<option value="">选择成员</option>
									{candidates.map(({ userId, displayName, roleTitle }) => (
										<option key={userId} value={userId}>
											{displayName || roleTitle}
										</option>
									))}
								</Select>
							</label>
							<div className="flex items-center gap-2">
								<Button type="submit" variant="primary" size="xs" disabled={!assignee || submitting}>
									保存
								</Button>
								<Button variant="inline" size="xs" onClick={() => setChangingAssignee(false)}>
									取消
								</Button>
							</div>
						</form>
					)}
				</>
			) : (
				<p className="m-0 text-xs text-ink-secondary">此请求已失效。</p>
			)}
			{error && <Banner tone="danger">{error}</Banner>}
		</section>
	);
}
