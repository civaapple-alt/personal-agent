import { create } from "zustand";
import { type HashRoute, type NavTab, parseHashRoute, type SettingsSection } from "../hashRouter.ts";

export type StateUpdater<T> = T | ((prev: T) => T);

export function resolveUpdater<T>(prev: T, next: StateUpdater<T>): T {
	return typeof next === "function" ? (next as (current: T) => T)(prev) : next;
}

export interface PendingArchiveConfirm {
	matterId: string;
	title: string;
	archived: boolean;
}

export interface WorkbenchStoreState {
	activeTab: NavTab;
	settingsSection: SettingsSection;
	spaceRoute: { pageId?: string };
	searchQuery: string;
	mobileNavOpen: boolean;
	errorBanner: string | null;
	noticeBanner: string | null;
	pendingArchiveConfirm: PendingArchiveConfirm | null;
	archivingMatter: boolean;

	initFromRoute: (route: HashRoute) => void;
	setActiveTab: (next: StateUpdater<NavTab>) => void;
	setSettingsSection: (next: StateUpdater<SettingsSection>) => void;
	setSpaceRoute: (next: StateUpdater<{ pageId?: string }>) => void;
	setSearchQuery: (next: StateUpdater<string>) => void;
	setMobileNavOpen: (next: StateUpdater<boolean>) => void;
	setErrorBanner: (next: StateUpdater<string | null>) => void;
	setNoticeBanner: (next: StateUpdater<string | null>) => void;
	dismissError: () => void;
	dismissNotice: () => void;
	openArchiveConfirm: (confirm: PendingArchiveConfirm) => void;
	closeArchiveConfirm: () => void;
	setArchivingMatter: (next: StateUpdater<boolean>) => void;
	resetUiState: () => void;
}

function readInitialRoute(): HashRoute {
	const hash = (globalThis as { location?: { hash?: string } }).location?.hash;
	return typeof hash === "string" ? parseHashRoute(hash) : { tab: "chats" };
}

const initialRoute = readInitialRoute();

export const useWorkbenchStore = create<WorkbenchStoreState>((set) => ({
	activeTab: initialRoute.tab,
	settingsSection: initialRoute.settingsSection ?? "all",
	spaceRoute: { pageId: initialRoute.spacePageId },
	searchQuery: "",
	mobileNavOpen: false,
	errorBanner: null,
	noticeBanner: null,
	pendingArchiveConfirm: null,
	archivingMatter: false,

	initFromRoute: (route) =>
		set({
			activeTab: route.tab,
			settingsSection: route.settingsSection ?? "all",
			spaceRoute: { pageId: route.spacePageId },
		}),
	setActiveTab: (next) => set((state) => ({ activeTab: resolveUpdater(state.activeTab, next) })),
	setSettingsSection: (next) => set((state) => ({ settingsSection: resolveUpdater(state.settingsSection, next) })),
	setSpaceRoute: (next) => set((state) => ({ spaceRoute: resolveUpdater(state.spaceRoute, next) })),
	setSearchQuery: (next) => set((state) => ({ searchQuery: resolveUpdater(state.searchQuery, next) })),
	setMobileNavOpen: (next) => set((state) => ({ mobileNavOpen: resolveUpdater(state.mobileNavOpen, next) })),
	setErrorBanner: (next) => set((state) => ({ errorBanner: resolveUpdater(state.errorBanner, next) })),
	setNoticeBanner: (next) => set((state) => ({ noticeBanner: resolveUpdater(state.noticeBanner, next) })),
	dismissError: () => set({ errorBanner: null }),
	dismissNotice: () => set({ noticeBanner: null }),
	openArchiveConfirm: (confirm) => set({ pendingArchiveConfirm: confirm }),
	closeArchiveConfirm: () => set({ pendingArchiveConfirm: null }),
	setArchivingMatter: (next) => set((state) => ({ archivingMatter: resolveUpdater(state.archivingMatter, next) })),
	resetUiState: () =>
		set({
			searchQuery: "",
			mobileNavOpen: false,
			errorBanner: null,
			noticeBanner: null,
			pendingArchiveConfirm: null,
			archivingMatter: false,
		}),
}));
