import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson } from "../api/client.ts";

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
		<section className="server-directory-picker" aria-label="选择服务器目录">
			<div className="server-directory-header">
				<strong>选择服务器目录</strong>
				<button type="button" className="btn-inline" onClick={onClose}>
					关闭
				</button>
			</div>
			<p className="muted-hint">浏览运行服务的机器上的目录。隐藏目录和符号链接不在列表中，可手动输入路径。</p>
			{listing && (
				<div className="server-directory-path">
					<code>{listing.path}</code>
				</div>
			)}
			{listing && listing.roots.length > 1 && (
				<div className="server-directory-roots">
					<span>允许的目录：</span>
					{listing.roots.map((root) => (
						<button type="button" className="btn-inline" key={root} onClick={() => void browse(root)}>
							{root}
						</button>
					))}
				</div>
			)}
			{error && (
				<p role="alert">
					{error}{" "}
					<button type="button" className="btn-inline" onClick={() => void browse()}>
						返回默认目录
					</button>
				</p>
			)}
			{loading && <output>正在读取目录…</output>}
			{listing && !loading && (
				<>
					<div className="server-directory-list">
						{listing.parent && (
							<button type="button" onClick={() => void browse(listing.parent ?? undefined)}>
								↑ 上一级
							</button>
						)}
						{listing.directories.map((dir) => (
							<button type="button" key={dir.path} onClick={() => void browse(dir.path)}>
								📁 {dir.name}
							</button>
						))}
						{listing.directories.length === 0 && <span className="muted-hint">没有可浏览的子目录</span>}
					</div>
					<button type="button" className="btn-pill-dark btn-xs" onClick={() => onSelect(listing.path)}>
						选择此目录
					</button>
				</>
			)}
		</section>
	);
}
