import type { PreviewServiceDto } from "@pa/contracts/runtime";
import type { FeedbackRating } from "@pa/contracts/space";
import { requestJson } from "./client.ts";

export type { FeedbackRating, PreviewServiceDto };

export function stopPreview(previewId: string): Promise<{ preview: PreviewServiceDto }> {
	return requestJson(`/api/previews/${encodeURIComponent(previewId)}/stop`, {
		method: "POST",
		body: "{}",
	});
}
