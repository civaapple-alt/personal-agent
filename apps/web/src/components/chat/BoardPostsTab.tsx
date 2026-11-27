import type { BoardPostDto, BoardPostKind, BoardPostSummaryDto } from "../../api.ts";
import { MarkdownView } from "../../MarkdownView.tsx";

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
		<div className="board-posts-tab">
			<div className="board-posts-toolbar">
				<input
					type="search"
					className="input-field board-search-input"
					aria-label="搜索公告板帖子"
					placeholder="搜索 #帖号、作者、@提及或摘要…"
					value={postQuery}
					onChange={(event) => onPostQueryChange(event.target.value)}
				/>
				<fieldset className="board-filter-pills" aria-label="按类型筛选板帖">
					{POST_KIND_FILTERS.map((item) => (
						<button
							key={item.value}
							type="button"
							className={`board-filter-pill${postKindFilter === item.value ? " active" : ""}`}
							aria-pressed={postKindFilter === item.value}
							onClick={() => onPostKindFilterChange(item.value)}
						>
							{item.label}
						</button>
					))}
				</fieldset>
			</div>

			<div className="board-posts-list">
				{filteredPosts.length === 0 ? (
					<div className="board-empty-state">
						<p>{totalPostCount === 0 ? "公告板暂无帖子。" : "没有匹配当前筛选条件的板帖。"}</p>
					</div>
				) : (
					filteredPosts.map((post) => {
						const isExpanded = Boolean(expandedPostNos[post.postNo]);
						const fullPost = postBodiesByNo[post.postNo];
						const isLoadingBody = Boolean(loadingPostNos[post.postNo]);
						const bodyError = postBodyErrors[post.postNo];
						const canExpandBody = Boolean(post.hasBody || fullPost);
						return (
							<article key={post.postNo} className={`board-post-card is-${post.kind}`}>
								<header className="board-post-head">
									<div className="board-post-meta-left">
										<span className="board-post-no">#{post.postNo}</span>
										<span className={`board-kind-badge is-${post.kind}`}>{postKindLabel(post.kind)}</span>
										{post.verification && (
											<span className={`board-verdict-badge is-${post.verification.verdict}`}>
												验收：{post.verification.verdict}
											</span>
										)}
									</div>
									<span className="board-post-time">{formatTime(post.createdAt)}</span>
								</header>

								<div className="board-post-routing">
									<span className="board-post-author">
										@{post.authorId}
										{post.authorType === "user" ? " (用户)" : post.authorType === "monitor" ? " (巡检)" : ""}
									</span>
									{post.mentions.length > 0 && (
										<>
											<span className="board-post-arrow" aria-hidden="true">
												→
											</span>
											<span className="board-post-mentions">
												{post.mentions.map((m) => `@${m}`).join(" ")}
											</span>
										</>
									)}
									{post.refPostNos.length > 0 && (
										<span className="board-post-refs">
											引用 {post.refPostNos.map((n) => `#${n}`).join(", ")}
										</span>
									)}
								</div>

								<p className="board-post-summary">{post.summary}</p>

								{canExpandBody && (
									<div className="board-post-actions">
										<button
											type="button"
											className="btn-inline"
											aria-expanded={isExpanded}
											onClick={() => onTogglePostBody(post.postNo)}
										>
											{isLoadingBody ? "加载正文中…" : isExpanded ? "收起正文" : "查看正文"}
										</button>
									</div>
								)}

								{bodyError && (
									<p className="board-post-body-error" role="alert">
										加载正文失败：{bodyError}
									</p>
								)}

								{isExpanded && fullPost && (
									<div className="board-post-body">
										{fullPost.body ? (
											<MarkdownView content={fullPost.body} />
										) : (
											<p className="board-empty-hint">该板帖无额外正文。</p>
										)}
										{fullPost.artifacts && (
											<div className="board-post-artifacts">
												{fullPost.artifacts.files && fullPost.artifacts.files.length > 0 && (
													<div className="board-artifact-row">
														<span className="board-artifact-label">变更文件</span>
														<div className="board-scope-chips">
															{fullPost.artifacts.files.map((file) => (
																<span key={file.path} className="board-scope-chip">
																	{file.path}
																	{file.linesAdded !== undefined ? ` +${file.linesAdded}` : ""}
																	{file.linesDeleted !== undefined ? ` -${file.linesDeleted}` : ""}
																</span>
															))}
														</div>
													</div>
												)}
												{fullPost.artifacts.commits && fullPost.artifacts.commits.length > 0 && (
													<div className="board-artifact-row">
														<span className="board-artifact-label">Commits</span>
														<div className="board-scope-chips">
															{fullPost.artifacts.commits.map((hash) => (
																<span key={hash} className="board-scope-chip">
																	{hash.slice(0, 8)}
																</span>
															))}
														</div>
													</div>
												)}
												{fullPost.artifacts.commands && fullPost.artifacts.commands.length > 0 && (
													<div className="board-artifact-row">
														<span className="board-artifact-label">验证命令</span>
														<div className="board-scope-chips">
															{fullPost.artifacts.commands.map((cmd) => (
																<span key={cmd} className="board-scope-chip">
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
							</article>
						);
					})
				)}
			</div>

			{canPostToBoard && (
				<form
					className="board-composer"
					onSubmit={(event) => {
						event.preventDefault();
						onSubmitBoardPost();
					}}
				>
					<div className="board-composer-top">
						<select
							className="select-sm"
							aria-label="板帖类型"
							value={composeKind}
							onChange={(event) => onComposeKindChange(event.target.value as BoardPostKind)}
						>
							{COMPOSER_KIND_OPTIONS.map((opt) => (
								<option key={opt.value} value={opt.value}>
									{opt.label}
								</option>
							))}
						</select>
						<fieldset className="board-mention-chips" aria-label="选择唤醒成员">
							{mentionCandidates.map((agentId) => {
								const active = composeMentions.includes(agentId);
								return (
									<button
										key={agentId}
										type="button"
										className={`board-mention-chip${active ? " active" : ""}`}
										aria-pressed={active}
										onClick={() => onToggleMention(agentId)}
									>
										@{agentId}
									</button>
								);
							})}
						</fieldset>
					</div>

					<input
						type="text"
						className="input-field board-composer-summary"
						aria-label="公告板摘要"
						placeholder="输入摘要直接发帖到公告板（点选上方 @成员 可定向唤醒）…"
						value={composeSummary}
						disabled={composeSubmitting}
						onChange={(event) => onComposeSummaryChange(event.target.value)}
					/>

					{composeShowBody && (
						<textarea
							className="input-field board-composer-textarea"
							aria-label="公告板完整正文"
							rows={3}
							placeholder="可选：补充详细说明或验收要求（支持 Markdown）"
							value={composeBody}
							disabled={composeSubmitting}
							onChange={(event) => onComposeBodyChange(event.target.value)}
						/>
					)}

					{composeError && (
						<div className="board-inline-error" role="alert">
							<span>{composeError}</span>
						</div>
					)}

					<div className="board-composer-foot">
						<button type="button" className="btn-inline" onClick={onToggleComposeShowBody}>
							{composeShowBody ? "隐藏正文" : "+ 补充正文"}
						</button>
						<button
							type="submit"
							className="btn-pill-dark btn-xs"
							disabled={composeSubmitting || (!composeSummary.trim() && !composeBody.trim())}
						>
							{composeSubmitting ? "发布中…" : "发布板帖"}
						</button>
					</div>
				</form>
			)}
		</div>
	);
}
