import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "../api/client.ts";
import { Banner, Button } from "../primitives/index.ts";

interface DirectoryListing {
	path: string;
	parent: string | null;
	roots: string[];
	directories: Array<{ name: string; path: string }>;
}

interface ServerDirectoryPickerProps {
	orgId?: string | null;
	workspaceId?: string;
	initialPath: string;
	onSelect: (path: string) => void;
	onClose: () => void;
}

export function ServerDirectoryPicker({
	orgId,
	workspaceId,
	initialPath,
	onSelect,
	onClose,
}: ServerDirectoryPickerProps) {
	const [listing, setListing] = useState<DirectoryListing | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const requestId = useRef(0);

	useEffect(() => {
		return () => {
			requestId.current += 1;
		};
	}, []);

	const browse = useCallback(
		async (path?: string) => {
			const id = ++requestId.current;
			setLoading(true);
			setError("");
			const query = new URLSearchParams();
			if (orgId) query.set("orgId", orgId);
			if (workspaceId) query.set("workspaceId", workspaceId);
			if (path) query.set("path", path);
			try {
				const result = await requestJson<DirectoryListing>(`/api/workspaces/directory-browser?${query}`);
				if (id === requestId.current) setListing(result);
			} catch (err) {
				if (id === requestId.current) setError(err instanceof Error ? err.message : String(err));
			} finally {
				if (id === requestId.current) setLoading(false);
			}
		},
		[orgId, workspaceId],
	);

	useEffect(() => {
		void browse(initialPath.trim() || undefined);
	}, [browse, initialPath]);

	return (
		<section className="border border-line rounded-lg p-3 flex flex-col gap-2 bg-card" aria-label="选择服务器目录">
			<div className="flex items-center justify-between gap-2">
				<strong className="text-xs font-semibold text-ink">选择服务器目录</strong>
				<Button variant="inline" size="xs" onClick={onClose}>
					关闭
				</Button>
			</div>
			<p className="m-0 text-xs text-ink-muted leading-normal">
				浏览运行服务的机器上的目录。隐藏目录和符号链接不在列表中，可手动输入路径。
			</p>
			{listing && (
				<div className="px-2 py-1 rounded-xs bg-subtle text-xs font-mono text-ink-secondary break-all">
					<code>{listing.path}</code>
				</div>
			)}
			{listing && listing.roots.length > 1 && (
				<div className="flex items-center flex-wrap gap-1.5 text-xs text-ink-secondary">
					<span>允许的目录：</span>
					{listing.roots.map((root) => (
						<Button key={root} variant="inline" size="xs" onClick={() => void browse(root)}>
							{root}
						</Button>
					))}
				</div>
			)}
			{error && (
				<Banner
					tone="danger"
					actions={
						<Button variant="inline" size="xs" onClick={() => void browse()}>
							返回默认目录
						</Button>
					}
				>
					{error}
				</Banner>
			)}
			{loading && <output className="text-xs text-ink-muted">正在读取目录…</output>}
			{listing && !loading && (
				<>
					<div className="flex flex-col max-h-[220px] overflow-y-auto border border-line-subtle rounded-sm p-1 bg-surface">
						{listing.parent && (
							<button
								type="button"
								className="text-left px-2 py-1.5 border-0 bg-transparent rounded-xs text-xs text-ink-secondary hover:bg-hover hover:text-ink cursor-pointer transition-colors"
								onClick={() => void browse(listing.parent ?? undefined)}
							>
								↑ 上一级
							</button>
						)}
						{listing.directories.map((dir) => (
							<button
								type="button"
								key={dir.path}
								className="text-left px-2 py-1.5 border-0 bg-transparent rounded-xs text-xs text-ink hover:bg-hover cursor-pointer transition-colors"
								onClick={() => void browse(dir.path)}
							>
								📁 {dir.name}
							</button>
						))}
						{listing.directories.length === 0 && (
							<span className="px-2 py-1.5 text-xs text-ink-muted">没有可浏览的子目录</span>
						)}
					</div>
					<div className="flex items-center">
						<Button variant="primary" size="xs" onClick={() => onSelect(listing.path)}>
							选择此目录
						</Button>
					</div>
				</>
			)}
		</section>
	);
}
