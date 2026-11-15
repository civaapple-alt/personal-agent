import { useRef } from "react";
import { abortRsiDistillation, type DistillRsiResult, distillRsiExperiences, type FeedbackRating } from "../api.ts";

interface UseRsiDistillParams {
	selectedMatterId: string | null;
	memberName: (id: string) => string;
	refreshBootstrap: () => Promise<void>;
	refreshDetail: (matterId: string | null) => Promise<void>;
	setNoticeBanner: (msg: string | null) => void;
	setErrorBanner: (msg: string | null) => void;
}

/** Coordinates in-flight AI experience distillation requests and user cancellations per matter. */
export function useRsiDistill({
	selectedMatterId,
	memberName,
	refreshBootstrap,
	refreshDetail,
	setNoticeBanner,
	setErrorBanner,
}: UseRsiDistillParams) {
	const distillAbortRef = useRef<Map<string, AbortController>>(new Map());

	const cancelRsiDistill = (matterId: string) => {
		const controller = distillAbortRef.current.get(matterId);
		if (controller) {
			controller.abort();
			distillAbortRef.current.delete(matterId);
		}
		setNoticeBanner("已取消本次 AI 经验复盘");
		void abortRsiDistillation(matterId).catch(() => {});
	};

	const runRsiDistill = async (input: {
		matterId: string;
		deliverableId?: string;
		feedback?: string;
		rating?: FeedbackRating;
	}): Promise<DistillRsiResult | undefined> => {
		const prevController = distillAbortRef.current.get(input.matterId);
		if (prevController) {
			prevController.abort();
		}
		const controller = new AbortController();
		distillAbortRef.current.set(input.matterId, controller);
		try {
			const res = await distillRsiExperiences(
				{
					matterId: input.matterId,
					deliverableId: input.deliverableId,
					feedback: input.feedback,
					rating: input.rating,
					scopeMode: "team",
				},
				controller.signal,
			);
			if (res.aborted || controller.signal.aborted) {
				setNoticeBanner("已取消本次 AI 经验复盘");
				return { ...res, aborted: true };
			}
			if (res.createdMemories.length > 0) {
				const roleNames = Array.from(new Set(res.createdMemories.map((m) => memberName(m.memberId))));
				setNoticeBanner(
					`已为 ${roleNames.join("、")} 提炼 ${res.createdMemories.length} 条经验，可在当前界面直接核验通过或修改归属`,
				);
			} else {
				setNoticeBanner(
					res.skippedDuplicates > 0
						? `AI 复盘未新增重复经验（跳过 ${res.skippedDuplicates} 条相似经验）`
						: `AI 复盘完成：${res.summary}`,
				);
			}
			await refreshBootstrap();
			if (selectedMatterId) {
				await refreshDetail(selectedMatterId);
			}
			return res;
		} catch (err) {
			if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
				setNoticeBanner("已取消本次 AI 经验复盘");
				return {
					ok: false,
					aborted: true,
					createdMemories: [],
					skippedDuplicates: 0,
					summary: "已取消 AI 经验复盘",
				};
			}
			setErrorBanner(err instanceof Error ? err.message : String(err));
			return undefined;
		} finally {
			if (distillAbortRef.current.get(input.matterId) === controller) {
				distillAbortRef.current.delete(input.matterId);
			}
		}
	};

	return { cancelRsiDistill, runRsiDistill };
}
