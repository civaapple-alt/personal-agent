import { requestJson } from "./client.ts";
import type { MemberMemoryDto } from "./experiences.ts";

export type FeedbackRating = "positive" | "negative" | "neutral";

export interface DeliverableDto {
	id: string;
	matterId: string;
	memberId: string;
	type: "document" | "artifact" | "prototype_image" | "service_url";
	title: string;
	summary: string;
	contentOrPath: string;
	serviceUrl: string | null;
	version: number;
	feedback: string | null;
	feedbackRating?: FeedbackRating | null;
	createdAt: string;
}

export interface PreviewServiceDto {
	id: string;
	title: string;
	url: string;
	port: number;
	cwd: string;
	status: "starting" | "running" | "stopped" | "failed";
	deliverableId: string | null;
}

export interface DeliverableFeedbackResult {
	ok: boolean;
	deliverableId: string;
	feedback: string;
	rating: FeedbackRating | null;
	evaluatedMemoryIds: string[];
	distilledMemories: MemberMemoryDto[];
	distillationError?: string;
}

export function submitDeliverableFeedback(
	deliverableId: string,
	payload:
		| string
		| {
				feedback?: string;
				rating?: FeedbackRating;
				autoDistill?: boolean;
				scopeMode?: "team" | "single";
		  },
): Promise<DeliverableFeedbackResult> {
	const body = typeof payload === "string" ? { feedback: payload } : payload;
	return requestJson(`/api/deliverables/${encodeURIComponent(deliverableId)}/feedback`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}

export function stopPreview(previewId: string): Promise<{ preview: PreviewServiceDto }> {
	return requestJson(`/api/previews/${encodeURIComponent(previewId)}/stop`, {
		method: "POST",
		body: "{}",
	});
}
