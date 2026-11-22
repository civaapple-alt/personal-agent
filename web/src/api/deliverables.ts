import { requestJson } from "./client.ts";

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
	matterId: string | null;
}

export function stopPreview(previewId: string): Promise<{ preview: PreviewServiceDto }> {
	return requestJson(`/api/previews/${encodeURIComponent(previewId)}/stop`, {
		method: "POST",
		body: "{}",
	});
}
