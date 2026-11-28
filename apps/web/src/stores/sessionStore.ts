import { create } from "zustand";
import type { BootstrapPayload } from "../api.ts";
import { parseHashRoute } from "../hashRouter.ts";
import { readStoredSetting } from "../utils/storage.ts";
import { resolveUpdater, type StateUpdater } from "./workbenchStore.ts";

function syncEditionDocumentTitle(requireAuth: boolean | undefined): void {
	if (typeof requireAuth !== "boolean") return;
	const doc = (globalThis as { document?: { title: string } }).document;
	if (!doc) return;
	doc.title = requireAuth ? "Personal Agent · 团队版" : "Personal Agent · 个人版";
}

function readInitialMemberId(): string {
	const hash = (globalThis as { location?: { hash?: string } }).location?.hash;
	if (typeof hash !== "string") return "auto";
	const initial = parseHashRoute(hash);
	return initial.isNewMatter && initial.newMatterLeadId ? initial.newMatterLeadId : "auto";
}

export interface SessionStoreState {
	bootstrap: BootstrapPayload | null;
	serverRequireAuth: boolean | null;
	selectedOrgId: string;
	selectedWorkspaceId: string;
	selectedMemberId: string;

	setBootstrap: (next: StateUpdater<BootstrapPayload | null>) => void;
	applyEditionState: (requireAuth: boolean | undefined) => void;
	setSelectedOrgId: (next: StateUpdater<string>) => void;
	setSelectedWorkspaceId: (next: StateUpdater<string>) => void;
	setSelectedMemberId: (next: StateUpdater<string>) => void;
	syncScopeFromBootstrap: (data: BootstrapPayload) => void;
	resetSessionData: () => void;
}

export const useSessionStore = create<SessionStoreState>((set) => ({
	bootstrap: null,
	serverRequireAuth: null,
	selectedOrgId: readStoredSetting("pa.defaultOrgId"),
	selectedWorkspaceId: readStoredSetting("pa.defaultWorkspaceId"),
	selectedMemberId: readInitialMemberId(),

	setBootstrap: (next) => set((state) => ({ bootstrap: resolveUpdater(state.bootstrap, next) })),
	applyEditionState: (requireAuth) => {
		if (typeof requireAuth !== "boolean") return;
		syncEditionDocumentTitle(requireAuth);
		set({ serverRequireAuth: requireAuth });
	},
	setSelectedOrgId: (next) => set((state) => ({ selectedOrgId: resolveUpdater(state.selectedOrgId, next) })),
	setSelectedWorkspaceId: (next) =>
		set((state) => ({ selectedWorkspaceId: resolveUpdater(state.selectedWorkspaceId, next) })),
	setSelectedMemberId: (next) => set((state) => ({ selectedMemberId: resolveUpdater(state.selectedMemberId, next) })),
	syncScopeFromBootstrap: (data) =>
		set((state) => {
			let resolvedWorkspaceId = "";
			if (state.selectedWorkspaceId && data.workspaces.some((w) => w.id === state.selectedWorkspaceId)) {
				resolvedWorkspaceId = state.selectedWorkspaceId;
			} else {
				const savedWs = readStoredSetting("pa.defaultWorkspaceId", "__unset__");
				if (savedWs !== "__unset__") {
					resolvedWorkspaceId = savedWs && data.workspaces.some((w) => w.id === savedWs) ? savedWs : "";
				} else {
					resolvedWorkspaceId = data.workspaces[0]?.id || "";
				}
			}

			const resolvedWs = resolvedWorkspaceId
				? (data.workspaces.find((w) => w.id === resolvedWorkspaceId) ?? null)
				: null;

			let resolvedOrgId = state.selectedOrgId;
			if (!(resolvedOrgId && data.organizations.some((o) => o.id === resolvedOrgId))) {
				if (resolvedWs?.orgId) {
					resolvedOrgId = resolvedWs.orgId;
				} else {
					const savedOrg = readStoredSetting("pa.defaultOrgId", "__unset__");
					const canLeaveOrgUnbound =
						data.authKind !== "session" || data.accountUser?.platformRole === "super_admin";
					if (savedOrg !== "__unset__") {
						if (savedOrg && data.organizations.some((o) => o.id === savedOrg)) {
							resolvedOrgId = savedOrg;
						} else if (savedOrg === "" && canLeaveOrgUnbound) {
							resolvedOrgId = "";
						} else {
							resolvedOrgId = (data.organizations.find((o) => o.isDefault) ?? data.organizations[0])?.id ?? "";
						}
					} else {
						resolvedOrgId = (data.organizations.find((o) => o.isDefault) ?? data.organizations[0])?.id ?? "";
					}
				}
			}

			return {
				selectedWorkspaceId: resolvedWorkspaceId,
				selectedOrgId: resolvedOrgId,
			};
		}),
	resetSessionData: () => set({ bootstrap: null }),
}));

export function selectMemberName(bootstrap: BootstrapPayload | null, id: string): string {
	return bootstrap?.members.find((m) => m.id === id)?.displayName ?? id;
}

export function selectWorkspaceName(bootstrap: BootstrapPayload | null, id: string | null): string | null {
	return id ? (bootstrap?.workspaces.find((w) => w.id === id)?.name ?? id) : null;
}

export function selectOrganizationName(bootstrap: BootstrapPayload | null, id: string | null): string | null {
	return id ? (bootstrap?.organizations.find((o) => o.id === id)?.name ?? id) : null;
}
