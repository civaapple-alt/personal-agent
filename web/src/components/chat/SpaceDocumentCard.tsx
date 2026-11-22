export interface ChatSpaceDocumentItem {
	id: string;
	spaceId: string;
	title: string;
	revision: number;
	headCommit?: string;
	summary?: string;
}

/** Actionable card rendered under an AI reply for a saved Space document, supporting right-pane content and Git diff views. */
export function SpaceDocumentCard({
	doc,
	onOpen,
}: {
	doc: ChatSpaceDocumentItem;
	onOpen: (showDiff: boolean) => void;
}) {
	return (
		<div className="space-doc-card">
			<button type="button" className="space-doc-card-main" onClick={() => onOpen(false)}>
				<div className="space-doc-card-head">
					<span className="space-doc-card-icon" aria-hidden="true">
						📄
					</span>
					<strong className="space-doc-card-title">{doc.title}</strong>
					<span className="space-doc-card-rev">
						rev {doc.revision}
						{doc.headCommit ? ` · ${doc.headCommit.slice(0, 7)}` : ""}
					</span>
				</div>
				{doc.summary && <p className="space-doc-card-summary">{doc.summary}</p>}
			</button>
			<div className="space-doc-card-actions">
				<button type="button" className="btn-pill-outline btn-xs" onClick={() => onOpen(false)}>
					查看全文
				</button>
				{doc.revision > 1 && (
					<button type="button" className="btn-inline" onClick={() => onOpen(true)}>
						查看变更
					</button>
				)}
			</div>
		</div>
	);
}
