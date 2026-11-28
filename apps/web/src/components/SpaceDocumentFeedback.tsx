import { useEffect, useId, useState } from "react";
import { listSpaceDocumentFeedback, type SpaceDocumentFeedbackDto, saveSpaceDocumentFeedback } from "../api/space.ts";
import { Badge, Banner, Button, FieldGroup, Select, SettingsDisclosure, Textarea } from "../primitives/index.ts";

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
	const ratingId = useId();
	const feedbackId = useId();

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
		<SettingsDisclosure summary={`版本反馈（${entries.length}） · ${commitHash.slice(0, 7)}`} className="mt-4 pt-3">
			{entries.map((entry) => (
				<div key={entry.actorId} className="py-2 border-b border-line-subtle text-xs">
					<div className="flex items-center gap-1.5 flex-wrap">
						<strong className="text-ink">{entry.actorName}</strong>
						<Badge
							tone={entry.rating === "positive" ? "success" : entry.rating === "negative" ? "danger" : "neutral"}
							dot
							size="xs"
						>
							{entry.rating === "positive" ? "认可" : entry.rating === "negative" ? "需修改" : "反馈"}
						</Badge>
					</div>
					{entry.feedback && (
						<p className="mt-1 mb-0 whitespace-pre-wrap text-ink-secondary leading-relaxed">{entry.feedback}</p>
					)}
				</div>
			))}
			{canWrite && (
				<form className="flex flex-col gap-2.5 py-3" onSubmit={(event) => void submit(event)}>
					<FieldGroup label="评价" htmlFor={ratingId}>
						<Select
							id={ratingId}
							size="sm"
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
						</Select>
					</FieldGroup>
					<FieldGroup label="反馈意见" htmlFor={feedbackId} hint="再次保存会更新你对该版本的反馈。">
						<Textarea
							id={feedbackId}
							value={feedback}
							maxLength={5000}
							onChange={(event) => setFeedback(event.target.value)}
						/>
					</FieldGroup>
					<div className="flex items-center">
						<Button
							variant="secondary"
							size="xs"
							type="submit"
							disabled={saving || (!feedback.trim() && !rating)}
						>
							{saving ? "保存中…" : "保存反馈"}
						</Button>
					</div>
				</form>
			)}
			{error && <Banner tone="danger">{error}</Banner>}
		</SettingsDisclosure>
	);
}
