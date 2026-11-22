export interface ChatSpaceDocumentItem {
	id: string;
	spaceId: string;
	title: string;
	revision: number;
	headCommit?: string;
	summary?: string;
}

/** Actionable card rendered under an AI reply for a saved Space document, supporting right-pane open, diff view, and latest-turn proceed. */
export function SpaceDocumentCard({
	doc,
	canProceed,
	onOpen,
	onProceed,
}: {
	doc: ChatSpaceDocumentItem;
	canProceed: boolean;
	onOpen: (showDiff: boolean) => void;
	onProceed?: () => void;
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
				{canProceed && onProceed && (
					<button type="button" className="btn-pill-dark btn-xs space-doc-proceed-btn" onClick={onProceed}>
						确认并推进
					</button>
				)}
				{doc.revision > 1 && (
					<button type="button" className="btn-inline" onClick={() => onOpen(true)}>
						查看变更
					</button>
				)}
				<button type="button" className="btn-inline" onClick={() => onOpen(false)}>
					在右侧打开
				</button>
			</div>
		</div>
	);
}
