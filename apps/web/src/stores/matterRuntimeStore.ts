import type { ActiveRunSnapshotDto } from "@pa/contracts";
import { create } from "zustand";
import type { ModelSelection } from "../api/models.ts";
import type { MatterDetailPayload, MatterProgressDto, MatterVisibility } from "../api.ts";
import { parseHashRoute } from "../hashRouter.ts";
import { resolveUpdater, type StateUpdater } from "./workbenchStore.ts";

function readInitialMatterId(): string | null {
	const hash = (globalThis as { location?: { hash?: string } }).location?.hash;
	if (typeof hash !== "string") return null;
	const initial = parseHashRoute(hash);
	return initial.isNewMatter ? null : (initial.matterId ?? null);
}

export interface MatterRuntimeStoreState {
	selectedMatterId: string | null;
	matterDetail: MatterDetailPayload | null;
	sseConnected: boolean;
	submitting: boolean;
	streamingDelta: string;
	progressByMatter: Record<string, MatterProgressDto>;
	progressStartedAt: Record<string, number>;
	draftModelSelection: ModelSelection | null;
	draftMatterVisibility: MatterVisibility;
	defaultDraftAiMemberIds: string[] | null;
	draftObserversEnabled: boolean;

	setSelectedMatterId: (next: StateUpdater<string | null>) => void;
	setMatterDetail: (next: StateUpdater<MatterDetailPayload | null>) => void;
	setSseConnected: (next: StateUpdater<boolean>) => void;
	setSubmitting: (next: StateUpdater<boolean>) => void;
	setStreamingDelta: (next: StateUpdater<string>) => void;
	appendStreamingDelta: (chunk: string) => void;
	setProgressByMatter: (next: StateUpdater<Record<string, MatterProgressDto>>) => void;
	setProgressStartedAt: (next: StateUpdater<Record<string, number>>) => void;
	applyActiveRuns: (activeRuns: Record<string, ActiveRunSnapshotDto>) => void;
	upsertMatterProgress: (
		matterId: string,
		snapshot: MatterProgressDto,
		startedAtOverride?: number,
		streamingDelta?: string,
	) => void;
	clearMatterProgress: (matterId: string) => void;
	setDraftModelSelection: (next: StateUpdater<ModelSelection | null>) => void;
	setDraftMatterVisibility: (next: StateUpdater<MatterVisibility>) => void;
	setDraftAiMemberIds: (next: StateUpdater<string[] | null>) => void;
	setDraftObserversEnabled: (next: StateUpdater<boolean>) => void;
	resetRuntimeOnRevoke: () => void;
}

export const useMatterRuntimeStore = create<MatterRuntimeStoreState>((set) => ({
	selectedMatterId: readInitialMatterId(),
	matterDetail: null,
	sseConnected: false,
	submitting: false,
	streamingDelta: "",
	progressByMatter: {},
	progressStartedAt: {},
	draftModelSelection: null,
	draftMatterVisibility: "org",
	defaultDraftAiMemberIds: null,
	draftObserversEnabled: false,

	setSelectedMatterId: (next) => set((state) => ({ selectedMatterId: resolveUpdater(state.selectedMatterId, next) })),
	setMatterDetail: (next) => set((state) => ({ matterDetail: resolveUpdater(state.matterDetail, next) })),
	setSseConnected: (next) => set((state) => ({ sseConnected: resolveUpdater(state.sseConnected, next) })),
	setSubmitting: (next) => set((state) => ({ submitting: resolveUpdater(state.submitting, next) })),
	setStreamingDelta: (next) => set((state) => ({ streamingDelta: resolveUpdater(state.streamingDelta, next) })),
	appendStreamingDelta: (chunk) => set((state) => ({ streamingDelta: state.streamingDelta + chunk })),
	setProgressByMatter: (next) => set((state) => ({ progressByMatter: resolveUpdater(state.progressByMatter, next) })),
	setProgressStartedAt: (next) =>
		set((state) => ({ progressStartedAt: resolveUpdater(state.progressStartedAt, next) })),
	applyActiveRuns: (activeRuns) => {
		const nextProgress: Record<string, MatterProgressDto> = {};
		const nextStartedAt: Record<string, number> = {};
		for (const [id, snapshot] of Object.entries(activeRuns)) {
			nextProgress[id] = snapshot;
			nextStartedAt[id] = snapshot.startedAt;
		}
		set({
			progressByMatter: nextProgress,
			progressStartedAt: nextStartedAt,
		});
	},
	upsertMatterProgress: (matterId, snapshot, startedAtOverride, streamingDelta) =>
		set((state) => ({
			progressByMatter: { ...state.progressByMatter, [matterId]: snapshot },
			progressStartedAt: {
				...state.progressStartedAt,
				[matterId]: state.progressStartedAt[matterId] ?? startedAtOverride ?? Date.now(),
			},
			...(streamingDelta !== undefined ? { streamingDelta } : {}),
		})),
	clearMatterProgress: (matterId) =>
		set((state) => {
			if (!(matterId in state.progressByMatter) && !(matterId in state.progressStartedAt)) {
				return state;
			}
			const nextProgress = { ...state.progressByMatter };
			delete nextProgress[matterId];
			const nextStartedAt = { ...state.progressStartedAt };
			delete nextStartedAt[matterId];
			return {
				progressByMatter: nextProgress,
				progressStartedAt: nextStartedAt,
			};
		}),
	setDraftModelSelection: (next) =>
		set((state) => ({ draftModelSelection: resolveUpdater(state.draftModelSelection, next) })),
	setDraftMatterVisibility: (next) =>
		set((state) => ({ draftMatterVisibility: resolveUpdater(state.draftMatterVisibility, next) })),
	setDraftAiMemberIds: (next) =>
		set((state) => ({ defaultDraftAiMemberIds: resolveUpdater(state.defaultDraftAiMemberIds, next) })),
	setDraftObserversEnabled: (next) =>
		set((state) => ({ draftObserversEnabled: resolveUpdater(state.draftObserversEnabled, next) })),
	resetRuntimeOnRevoke: () =>
		set({
			matterDetail: null,
			progressByMatter: {},
			progressStartedAt: {},
			streamingDelta: "",
			sseConnected: false,
		}),
}));
