import { useEffect, useState } from "react";
import {
	createSpacePage,
	listSpacePageRevisions,
	listSpacePages,
	type SpacePage,
	type SpacePageRevision,
	updateSpacePage,
} from "../api/space.ts";
import type { BootstrapPayload } from "../api.ts";
import { MarkdownView } from "../MarkdownView.tsx";

export function SpacePages({
	bootstrap,
	pageId,
	onOpenMatter,
}: {
	bootstrap: BootstrapPayload | null;
	pageId?: string;
	onOpenMatter: (id: string) => void;
}) {
	const [pages, setPages] = useState<SpacePage[]>([]);
	const [selected, setSelected] = useState<SpacePage | null>(null);
	const [revisions, setRevisions] = useState<SpacePageRevision[]>([]);
	const [editing, setEditing] = useState(false);
	const [matterId, setMatterId] = useState("");
	const [title, setTitle] = useState("");
	const [content, setContent] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [search, setSearch] = useState("");

	async function refresh() {
		const result = await listSpacePages();
		setPages(result.pages);
	}

	useEffect(() => {
		let cancelled = false;
		listSpacePages()
			.then((result) => {
				if (cancelled) return;
				setPages(result.pages);
				const initial = pageId ? result.pages.find((page) => page.id === pageId) : null;
				if (initial) {
					setSelected(initial);
					void listSpacePageRevisions(initial.id)
						.then(({ revisions }) => {
							if (!cancelled) setRevisions(revisions);
						})
						.catch((reason: unknown) => {
							if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
						});
				}
			})
			.catch((reason: unknown) => {
				if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => {
			cancelled = true;
		};
	}, [pageId]);

	useEffect(() => {
		const events = new EventSource("/api/events");
		const sync = () => {
			void listSpacePages()
				.then(({ pages }) => setPages(pages))
				.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
		};
		events.addEventListener("space_page_updated", sync);
		events.addEventListener("matter_settled", sync);
		events.addEventListener("matter_progress", (event) => {
			const progress = JSON.parse((event as MessageEvent).data) as { toolName?: string };
			if (progress.toolName === "save_space_page") sync();
		});
		return () => events.close();
	}, []);

	async function selectPage(page: SpacePage) {
		setSelected(page);
		setEditing(false);
		setRevisions([]);
		setError("");
		try {
			const result = await listSpacePageRevisions(page.id);
			setRevisions(result.revisions);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}

	function startNew() {
		setSelected(null);
		setMatterId(editableMatters[0]?.id ?? "");
		setTitle("");
		setContent("");
		setEditing(true);
		setError("");
	}

	async function save() {
		setBusy(true);
		setError("");
		try {
			const result = selected
				? await updateSpacePage(selected.id, { revision: selected.revision, title, content })
				: await createSpacePage({ matterId, title, content });
			await refresh();
			await selectPage(result.page);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
			await refresh().catch(() => {});
		} finally {
			setBusy(false);
		}
	}

	const editableMatters = (bootstrap?.matters ?? []).filter((matter) => {
		if (!bootstrap?.accountUser || bootstrap.accountUser.platformRole === "super_admin") return true;
		return bootstrap.organizations.find((org) => org.id === matter.orgId)?.orgRole !== "org_viewer";
	});
	const canEdit = selected ? editableMatters.some((matter) => matter.id === selected.matterId) : false;
	const latest = selected ? pages.find((page) => page.id === selected.id) : null;
	const visiblePages = pages.filter((page) =>
		`${page.title}\n${page.content}`.toLowerCase().includes(search.toLowerCase()),
	);
	return (
		<section className="space-pages">
			<div className="space-pages-toolbar">
				<input
					className="input-field"
					aria-label="搜索资料"
					placeholder="搜索资料"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
				<button type="button" className="btn-pill-dark" onClick={startNew} disabled={!editableMatters.length}>
					新建资料
				</button>
			</div>
			{error && (
				<p role="alert" className="space-error">
					{error}
				</p>
			)}
			<div className="space-pages-layout">
				<div className="space-pages-list">
					{visiblePages.length === 0 && (
						<p className="muted-hint">
							{pages.length ? "没有匹配的资料" : "还没有资料。可以新建计划、记录过程或保存结果。"}
						</p>
					)}
					{visiblePages.map((page) => (
						<button
							type="button"
							className={`space-page-row ${selected?.id === page.id ? "active" : ""}`}
							key={page.id}
							onClick={() => void selectPage(page)}
						>
							<strong>{page.title}</strong>
							<span>
								{bootstrap?.matters.find((matter) => matter.id === page.matterId)?.title ?? "事项"} ·{" "}
								{new Date(page.updatedAt).toLocaleDateString()}
							</span>
						</button>
					))}
				</div>
				<div className="space-page-detail">
					{editing ? (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								void save();
							}}
						>
							{!selected && (
								<label>
									所属事项
									<select
										className="input-field"
										value={matterId}
										onChange={(event) => setMatterId(event.target.value)}
										required
									>
										{editableMatters.map((matter) => (
											<option key={matter.id} value={matter.id}>
												{matter.title}
											</option>
										))}
									</select>
								</label>
							)}
							<label>
								标题
								<input
									className="input-field"
									value={title}
									onChange={(event) => setTitle(event.target.value)}
									maxLength={200}
									required
								/>
							</label>
							<label>
								正文
								<textarea
									className="input-field space-page-editor"
									value={content}
									onChange={(event) => setContent(event.target.value)}
									placeholder="支持 Markdown"
								/>
							</label>
							{selected && latest && latest.revision !== selected.revision && (
								<details open>
									<summary>资料已有新版本，你的编辑内容仍在上方</summary>
									<strong>{latest.title}</strong>
									<MarkdownView content={latest.content || "（空白）"} />
									<button
										type="button"
										className="btn-secondary"
										onClick={() => {
											setSelected(latest);
											setError("");
										}}
									>
										以新版本为基础继续保存
									</button>
								</details>
							)}
							<div className="space-page-actions">
								<button className="btn-pill-dark" type="submit" disabled={busy}>
									保存
								</button>
								{canEdit && (
									<button
										className="btn-secondary"
										type="button"
										onClick={() => setEditing(false)}
										disabled={busy}
									>
										取消
									</button>
								)}
							</div>
						</form>
					) : selected ? (
						<>
							<div className="space-page-heading">
								<h2>{selected.title}</h2>
								<button
									type="button"
									className="btn-secondary"
									onClick={() => {
										setTitle(selected.title);
										setContent(selected.content);
										setEditing(true);
									}}
								>
									编辑
								</button>
							</div>
							<button type="button" className="btn-inline" onClick={() => onOpenMatter(selected.matterId)}>
								查看所属事项
							</button>
							<div className="space-page-content">
								<MarkdownView content={selected.content || "（空白）"} />
							</div>
							<details>
								<summary>历史修订（{revisions.length}）</summary>
								{revisions.map((revision) => (
									<details key={revision.revision}>
										<summary>
											版本 {revision.revision} · {new Date(revision.createdAt).toLocaleString()} ·{" "}
											{revision.updatedBy}
										</summary>
										<strong>{revision.title}</strong>
										<MarkdownView content={revision.content || "（空白）"} />
									</details>
								))}
							</details>
						</>
					) : (
						<p className="muted-hint">选择资料查看，或新建资料。</p>
					)}
				</div>
			</div>
		</section>
	);
}
