import type { BoardPostDto, BoardPostKind, BoardPostSummaryDto } from "../../api.ts";
import { MarkdownView } from "../../MarkdownView.tsx";
import {
	Badge,
	type BadgeTone,
	Banner,
	Button,
	Card,
	EmptyState,
	Input,
	Select,
	Textarea,
} from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";

const POST_KIND_FILTERS: ReadonlyArray<{ value: BoardPostKind | "all"; label: string }> = [
	{ value: "all", label: "全部" },
	{ value: "assign", label: "分派" },
	{ value: "handoff", label: "交接" },
	{ value: "verify_pass", label: "验收通过" },
	{ value: "verify_rework", label: "验收打回" },
	{ value: "clarification", label: "澄清" },
	{ value: "escalate", label: "升级" },
	{ value: "summary", label: "总结" },
];

const COMPOSER_KIND_OPTIONS: ReadonlyArray<{ value: BoardPostKind; label: string }> = [
	{ value: "clarification", label: "澄清 / 指令" },
	{ value: "assign", label: "任务分派" },
	{ value: "handoff", label: "交接补充" },
	{ value: "escalate", label: "升级纠偏" },
	{ value: "progress", label: "进展同步" },
	{ value: "summary", label: "阶段总结" },
];

function postKindLabel(kind: BoardPostKind): string {
	switch (kind) {
		case "assign":
			return "分派";
		case "progress":
			return "进展";
		case "handoff":
			return "交接";
		case "verify_pass":
			return "验收通过";
		case "verify_rework":
			return "验收打回";
		case "escalate":
			return "升级";
		case "clarification":
			return "澄清";
		case "summary":
			return "总结";
	}
}

function postKindTone(kind: BoardPostKind): BadgeTone {
	switch (kind) {
		case "assign":
		case "handoff":
			return "info";
		case "verify_pass":
		case "summary":
			return "success";
		case "verify_rework":
		case "escalate":
		case "clarification":
			return "warn";
		case "progress":
			return "neutral";
	}
}

function verdictTone(verdict: string): BadgeTone {
	if (verdict === "pass") return "success";
	if (verdict === "rework") return "danger";
	return "warn";
}

function postCardBorderClass(kind: BoardPostKind): string {
	if (kind === "verify_rework" || kind === "escalate") return "border-warn-border";
	if (kind === "verify_pass") return "border-success-border";
	return "border-line";
}

export interface BoardPostsTabProps {
	totalPostCount: number;
	filteredPosts: BoardPostSummaryDto[];
	postQuery: string;
	onPostQueryChange: (value: string) => void;
	postKindFilter: BoardPostKind | "all";
	onPostKindFilterChange: (kind: BoardPostKind | "all") => void;
	expandedPostNos: Record<number, boolean>;
	postBodiesByNo: Record<number, BoardPostDto>;
	loadingPostNos: Record<number, boolean>;
	postBodyErrors: Record<number, string>;
	onTogglePostBody: (postNo: number) => void;
	canPostToBoard: boolean;
	composeKind: BoardPostKind;
	onComposeKindChange: (kind: BoardPostKind) => void;
	mentionCandidates: string[];
	composeMentions: string[];
	onToggleMention: (agentId: string) => void;
	composeSummary: string;
	onComposeSummaryChange: (value: string) => void;
	composeBody: string;
	onComposeBodyChange: (value: string) => void;
	composeShowBody: boolean;
	onToggleComposeShowBody: () => void;
	composeSubmitting: boolean;
	composeError: string | null;
	onSubmitBoardPost: () => void;
	formatTime: (iso: string) => string;
}

export function BoardPostsTab({
	totalPostCount,
	filteredPosts,
	postQuery,
	onPostQueryChange,
	postKindFilter,
	onPostKindFilterChange,
	expandedPostNos,
	postBodiesByNo,
	loadingPostNos,
	postBodyErrors,
	onTogglePostBody,
	canPostToBoard,
	composeKind,
	onComposeKindChange,
	mentionCandidates,
	composeMentions,
	onToggleMention,
	composeSummary,
	onComposeSummaryChange,
	composeBody,
	onComposeBodyChange,
	composeShowBody,
	onToggleComposeShowBody,
	composeSubmitting,
	composeError,
	onSubmitBoardPost,
	formatTime,
}: BoardPostsTabProps) {
	return (
		<div className="flex flex-col gap-2.5 flex-1 min-h-0">
			<div className="flex flex-col gap-2">
				<Input
					type="search"
					size="sm"
					aria-label="搜索公告板帖子"
					placeholder="搜索 #帖号、作者、@提及或摘要…"
					value={postQuery}
					onChange={(event) => onPostQueryChange(event.target.value)}
				/>
				<fieldset className="flex flex-wrap gap-1 m-0 p-0 border-0" aria-label="按类型筛选板帖">
					{POST_KIND_FILTERS.map((item) => {
						const active = postKindFilter === item.value;
						return (
							<button
								key={item.value}
								type="button"
								aria-pressed={active}
								onClick={() => onPostKindFilterChange(item.value)}
								className={cn(
									"px-2.5 py-0.5 rounded-pill text-micro border transition-colors cursor-pointer",
									active
										? "border-accent bg-accent-soft text-accent font-semibold"
										: "border-line bg-stage text-ink-secondary font-medium hover:border-line-strong hover:text-ink",
								)}
							>
								{item.label}
							</button>
						);
					})}
				</fieldset>
			</div>

			<div className="flex flex-col gap-2">
				{filteredPosts.length === 0 ? (
					<EmptyState compact title={totalPostCount === 0 ? "公告板暂无帖子。" : "没有匹配当前筛选条件的板帖。"} />
				) : (
					filteredPosts.map((post) => {
						const isExpanded = Boolean(expandedPostNos[post.postNo]);
						const fullPost = postBodiesByNo[post.postNo];
						const isLoadingBody = Boolean(loadingPostNos[post.postNo]);
						const bodyError = postBodyErrors[post.postNo];
						const canExpandBody = Boolean(post.hasBody || fullPost);
						return (
							<Card
								key={post.postNo}
								padding="sm"
								className={cn("board-post-card flex flex-col gap-1.5", postCardBorderClass(post.kind))}
							>
								<header className="flex items-center justify-between gap-2">
									<div className="flex items-center gap-1.5 flex-wrap">
										<span className="font-mono text-xs font-semibold text-ink">#{post.postNo}</span>
										<Badge tone={postKindTone(post.kind)} size="xs">
											{postKindLabel(post.kind)}
										</Badge>
										{post.verification && (
											<Badge tone={verdictTone(post.verification.verdict)} size="xs">
												验收：{post.verification.verdict}
											</Badge>
										)}
									</div>
									<span className="text-micro text-ink-muted shrink-0 tabular-nums">
										{formatTime(post.createdAt)}
									</span>
								</header>

								<div className="flex items-center gap-1.5 flex-wrap text-xs">
									<span className="font-mono font-semibold text-ink">
										@{post.authorId}
										{post.authorType === "user" ? " (用户)" : post.authorType === "monitor" ? " (巡检)" : ""}
									</span>
									{post.mentions.length > 0 && (
										<>
											<span className="text-ink-muted" aria-hidden="true">
												→
											</span>
											<span className="font-mono text-accent font-semibold">
												{post.mentions.map((m) => `@${m}`).join(" ")}
											</span>
										</>
									)}
									{post.refPostNos.length > 0 && (
										<span className="text-micro text-ink-muted">
											引用 {post.refPostNos.map((n) => `#${n}`).join(", ")}
										</span>
									)}
								</div>

								<p className="m-0 text-sm text-ink leading-normal break-words">{post.summary}</p>

								{canExpandBody && (
									<div className="flex items-center gap-2">
										<Button
											variant="inline"
											size="xs"
											aria-expanded={isExpanded}
											onClick={() => onTogglePostBody(post.postNo)}
										>
											{isLoadingBody ? "加载正文中…" : isExpanded ? "收起正文" : "查看正文"}
										</Button>
									</div>
								)}

								{bodyError && (
									<p className="m-0 text-xs text-danger-text" role="alert">
										加载正文失败：{bodyError}
									</p>
								)}

								{isExpanded && fullPost && (
									<div className="mt-1 pt-2 border-t border-dashed border-line text-sm">
										{fullPost.body ? (
											<MarkdownView content={fullPost.body} />
										) : (
											<p className="m-0 text-xs text-ink-muted leading-normal">该板帖无额外正文。</p>
										)}
										{fullPost.artifacts && (
											<div className="flex flex-col gap-1.5 mt-2 pt-2 border-t border-line-subtle">
												{fullPost.artifacts.files && fullPost.artifacts.files.length > 0 && (
													<div className="flex flex-col gap-1">
														<span className="text-micro font-semibold text-ink-muted">变更文件</span>
														<div className="flex flex-wrap gap-1">
															{fullPost.artifacts.files.map((file) => (
																<span
																	key={file.path}
																	className="inline-flex items-center max-w-full px-1.5 py-0.5 rounded-xs border border-line bg-surface text-ink-secondary font-mono text-micro truncate"
																>
																	{file.path}
																	{file.linesAdded !== undefined ? ` +${file.linesAdded}` : ""}
																	{file.linesDeleted !== undefined ? ` -${file.linesDeleted}` : ""}
																</span>
															))}
														</div>
													</div>
												)}
												{fullPost.artifacts.commits && fullPost.artifacts.commits.length > 0 && (
													<div className="flex flex-col gap-1">
														<span className="text-micro font-semibold text-ink-muted">Commits</span>
														<div className="flex flex-wrap gap-1">
															{fullPost.artifacts.commits.map((hash) => (
																<span
																	key={hash}
																	className="inline-flex items-center max-w-full px-1.5 py-0.5 rounded-xs border border-line bg-surface text-ink-secondary font-mono text-micro truncate"
																>
																	{hash.slice(0, 8)}
																</span>
															))}
														</div>
													</div>
												)}
												{fullPost.artifacts.commands && fullPost.artifacts.commands.length > 0 && (
													<div className="flex flex-col gap-1">
														<span className="text-micro font-semibold text-ink-muted">验证命令</span>
														<div className="flex flex-wrap gap-1">
															{fullPost.artifacts.commands.map((cmd) => (
																<span
																	key={cmd}
																	className="inline-flex items-center max-w-full px-1.5 py-0.5 rounded-xs border border-line bg-surface text-ink-secondary font-mono text-micro truncate"
																>
																	{cmd}
																</span>
															))}
														</div>
													</div>
												)}
											</div>
										)}
									</div>
								)}
							</Card>
						);
					})
				)}
			</div>

			{canPostToBoard && (
				<form
					className="flex flex-col gap-2 p-2.5 border border-line rounded-md bg-surface mt-auto"
					onSubmit={(event) => {
						event.preventDefault();
						onSubmitBoardPost();
					}}
				>
					<div className="flex items-center gap-1.5 flex-wrap">
						<Select
							size="sm"
							aria-label="板帖类型"
							value={composeKind}
							onChange={(event) => onComposeKindChange(event.target.value as BoardPostKind)}
							className="w-auto shrink-0"
						>
							{COMPOSER_KIND_OPTIONS.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</Select>
						<fieldset className="flex items-center gap-1 flex-wrap m-0 p-0 border-0" aria-label="选择唤醒成员">
							{mentionCandidates.map((agentId) => {
								const active = composeMentions.includes(agentId);
								return (
									<button
										key={agentId}
										type="button"
										aria-pressed={active}
										onClick={() => onToggleMention(agentId)}
										className={cn(
											"px-2 py-0.5 rounded-pill font-mono text-micro border transition-colors cursor-pointer",
											active
												? "border-accent bg-accent-soft text-accent font-semibold"
												: "border-line bg-stage text-ink-secondary hover:border-line-strong hover:text-ink",
										)}
									>
										@{agentId}
									</button>
								);
							})}
						</fieldset>
					</div>

					<Input
						type="text"
						size="sm"
						aria-label="公告板摘要"
						placeholder="输入摘要直接发帖到公告板（点选上方 @成员 可定向唤醒）…"
						value={composeSummary}
						disabled={composeSubmitting}
						onChange={(event) => onComposeSummaryChange(event.target.value)}
					/>

					{composeShowBody && (
						<Textarea
							aria-label="公告板完整正文"
							rows={3}
							placeholder="可选：补充详细说明或验收要求（支持 Markdown）"
							value={composeBody}
							disabled={composeSubmitting}
							onChange={(event) => onComposeBodyChange(event.target.value)}
							className="text-xs px-2.5 py-1.5"
						/>
					)}

					{composeError && <Banner tone="danger">{composeError}</Banner>}

					<div className="flex items-center justify-between gap-2">
						<Button variant="inline" size="xs" onClick={onToggleComposeShowBody}>
							{composeShowBody ? "隐藏正文" : "+ 补充正文"}
						</Button>
						<Button
							type="submit"
							variant="primary"
							size="xs"
							disabled={composeSubmitting || (!composeSummary.trim() && !composeBody.trim())}
						>
							{composeSubmitting ? "发布中…" : "发布板帖"}
						</Button>
					</div>
				</form>
			)}
		</div>
	);
}
