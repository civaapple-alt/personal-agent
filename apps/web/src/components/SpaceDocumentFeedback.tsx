import { useEffect, useState } from "react";
import { listSpaceDocumentFeedback, type SpaceDocumentFeedbackDto, saveSpaceDocumentFeedback } from "../api/space.ts";

export function SpaceDocumentFeedback({
	documentId,
	commitHash,
	canWrite,
}: {
	documentId: string;
	commitHash: string;
	canWrite: boolean;
}) {
	const [entries, setEntries] = useState<SpaceDocumentFeedbackDto[]>([]);
	const [feedback, setFeedback] = useState("");
	const [rating, setRating] = useState<SpaceDocumentFeedbackDto["rating"]>(null);
	const [error, setError] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void listSpaceDocumentFeedback(documentId)
			.then((result) => {
				if (!cancelled) setEntries(result.feedback.filter((entry) => entry.commitHash === commitHash));
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [documentId, commitHash]);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setSaving(true);
		setError("");
		try {
			await saveSpaceDocumentFeedback(documentId, { commitHash, feedback, rating });
			const result = await listSpaceDocumentFeedback(documentId);
			setEntries(result.feedback.filter((entry) => entry.commitHash === commitHash));
			setFeedback("");
			setRating(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<details className="space-commits-panel">
			<summary>
				版本反馈（{entries.length}） · {commitHash.slice(0, 7)}
			</summary>
			{entries.map((entry) => (
				<div key={entry.actorId} className="space-feedback-entry">
					<strong>{entry.actorName}</strong>
					{" · "}
					{entry.rating === "positive" ? "认可" : entry.rating === "negative" ? "需修改" : "反馈"}
					{entry.feedback && <p>{entry.feedback}</p>}
				</div>
			))}
			{canWrite && (
				<form className="space-feedback-form" onSubmit={(event) => void submit(event)}>
					<label>
						评价
						<select
							className="input-field"
							value={rating ?? ""}
							onChange={(event) => {
								const value = event.target.value;
								setRating(value === "positive" || value === "negative" || value === "neutral" ? value : null);
							}}
						>
							<option value="">不评分</option>
							<option value="positive">认可</option>
							<option value="negative">需修改</option>
							<option value="neutral">中立</option>
						</select>
					</label>
					<label>
						反馈意见
						<textarea
							className="input-field"
							value={feedback}
							maxLength={5000}
							onChange={(event) => setFeedback(event.target.value)}
						/>
					</label>
					<button
						className="btn-secondary btn-xs"
						type="submit"
						disabled={saving || (!feedback.trim() && !rating)}
					>
						{saving ? "保存中…" : "保存反馈"}
					</button>
					<span className="muted-hint">再次保存会更新你对该版本的反馈。</span>
				</form>
			)}
			{error && <p role="alert">{error}</p>}
		</details>
	);
}
