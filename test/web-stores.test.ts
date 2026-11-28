import assert from "node:assert/strict";
import test from "node:test";
import type { ActiveRunSnapshotDto, BootstrapPayload, MatterProgressDto } from "../apps/web/src/api.ts";
import {
	selectMemberName,
	selectOrganizationName,
	selectWorkspaceName,
	useMatterRuntimeStore,
	useSessionStore,
	useWorkbenchStore,
} from "../apps/web/src/stores/index.ts";

function createStorageMock(initial: Record<string, string> = {}) {
	const data = new Map<string, string>(Object.entries(initial));
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => {
			data.set(key, String(value));
		},
		removeItem: (key: string) => {
			data.delete(key);
		},
		clear: () => {
			data.clear();
		},
		key: (index: number) => Array.from(data.keys())[index] ?? null,
		get length() {
			return data.size;
		},
	} as Storage;
}

function makeBootstrap(overrides: Partial<BootstrapPayload> = {}): BootstrapPayload {
	return {
		authKind: "session",
		accountUser: {
			id: "usr_1",
			email: "owner@alpha.local",
			displayName: "Alpha Owner",
			platformRole: "user",
			status: "active",
			canDispatchAi: true,
			maxOrgs: 5,
			maxActiveDispatches: 4,
			maxPersonalRoles: 3,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		},
		organizations: [
			{
				id: "org_alpha",
				name: "Alpha Studio",
				isDefault: true,
				orgRole: "org_owner",
				useRoleGitIdentity: false,
				gitEmailDomain: "alpha.local",
				description: "",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			},
			{
				id: "org_beta",
				name: "Beta Labs",
				isDefault: false,
				orgRole: "org_member",
				useRoleGitIdentity: false,
				gitEmailDomain: "beta.local",
				description: "",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			},
		],
		workspaces: [
			{
				id: "ws_beta",
				orgId: "org_beta",
				name: "Beta App",
				repoPath: "/tmp/beta",
				defaultBranch: "main",
				description: "",
				visibility: "org",
				createdAt: "2026-01-01T00:00:00Z",
			},
		],
		members: [
			{
				id: "role_em",
				templateId: "engineering-manager",
				roleTitle: "Engineering Manager",
				displayName: "EM",
				isPrimaryContact: true,
				keywords: [],
				gitName: "EM",
				gitEmail: "em@local",
				identitySummary: "",
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
			},
		],
		templates: [],
		matters: [],
		pendingDialogs: [],
		previews: [],
		orgMembersByOrgId: {},
		orgAiRolesByOrgId: {},
		...overrides,
	};
}

test("workbenchStore manages route initialization, banners, and archive confirmation", () => {
	useWorkbenchStore.setState({
		activeTab: "chats",
		settingsSection: "all",
		spaceRoute: {},
		searchQuery: "stale",
		mobileNavOpen: true,
		errorBanner: "err",
		noticeBanner: "ok",
		pendingArchiveConfirm: null,
		archivingMatter: false,
	});

	useWorkbenchStore.getState().initFromRoute({
		tab: "settings",
		settingsSection: "skills",
		spacePageId: "sp_1",
	});
	let state = useWorkbenchStore.getState();
	assert.equal(state.activeTab, "settings");
	assert.equal(state.settingsSection, "skills");
	assert.equal(state.spaceRoute.pageId, "sp_1");

	useWorkbenchStore.getState().dismissError();
	useWorkbenchStore.getState().dismissNotice();
	useWorkbenchStore.getState().openArchiveConfirm({ matterId: "m_1", title: "Demo", archived: true });
	useWorkbenchStore.getState().setArchivingMatter(true);
	state = useWorkbenchStore.getState();
	assert.equal(state.errorBanner, null);
	assert.equal(state.noticeBanner, null);
	assert.deepEqual(state.pendingArchiveConfirm, { matterId: "m_1", title: "Demo", archived: true });
	assert.equal(state.archivingMatter, true);

	useWorkbenchStore.getState().resetUiState();
	state = useWorkbenchStore.getState();
	assert.equal(state.searchQuery, "");
	assert.equal(state.mobileNavOpen, false);
	assert.equal(state.pendingArchiveConfirm, null);
	assert.equal(state.archivingMatter, false);
});

test("sessionStore resolves org/workspace scope from stored defaults and super_admin permissions", () => {
	const prevStorage = globalThis.localStorage;
	try {
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: createStorageMock({ "pa.defaultWorkspaceId": "", "pa.defaultOrgId": "" }),
		});

		useSessionStore.setState({
			bootstrap: null,
			serverRequireAuth: null,
			selectedOrgId: "",
			selectedWorkspaceId: "",
			selectedMemberId: "auto",
		});

		// Member cannot leave org unbound even if pa.defaultOrgId=""
		const memberBoot = makeBootstrap();
		useSessionStore.getState().syncScopeFromBootstrap(memberBoot);
		let s = useSessionStore.getState();
		assert.equal(s.selectedWorkspaceId, "");
		assert.equal(s.selectedOrgId, "org_alpha");

		// Reset and test fallback to workspace's org when nothing is stored
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: createStorageMock({}),
		});
		useSessionStore.setState({ selectedOrgId: "", selectedWorkspaceId: "" });
		useSessionStore.getState().syncScopeFromBootstrap(memberBoot);
		s = useSessionStore.getState();
		assert.equal(s.selectedWorkspaceId, "ws_beta");
		assert.equal(s.selectedOrgId, "org_beta");

		// Super admin CAN keep org unbound when pa.defaultOrgId=""
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: createStorageMock({ "pa.defaultWorkspaceId": "", "pa.defaultOrgId": "" }),
		});
		const adminBoot = makeBootstrap({
			accountUser: {
				...makeBootstrap().accountUser!,
				platformRole: "super_admin",
			},
		});
		useSessionStore.setState({ selectedOrgId: "", selectedWorkspaceId: "" });
		useSessionStore.getState().syncScopeFromBootstrap(adminBoot);
		s = useSessionStore.getState();
		assert.equal(s.selectedWorkspaceId, "");
		assert.equal(s.selectedOrgId, "");

		assert.equal(selectMemberName(adminBoot, "role_em"), "EM");
		assert.equal(selectWorkspaceName(adminBoot, "ws_beta"), "Beta App");
		assert.equal(selectOrganizationName(adminBoot, "org_alpha"), "Alpha Studio");
	} finally {
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: prevStorage,
		});
	}
});

test("matterRuntimeStore handles active runs, progress upserts, streaming deltas, and revoke reset", () => {
	useMatterRuntimeStore.getState().resetRuntimeOnRevoke();
	useMatterRuntimeStore.getState().setSelectedMatterId("m_1");

	const activeRun: ActiveRunSnapshotDto = {
		matterId: "m_1",
		stage: "thinking",
		label: "思考中",
		startedAt: 1000,
	};
	useMatterRuntimeStore.getState().applyActiveRuns({ m_1: activeRun });
	assert.equal(useMatterRuntimeStore.getState().progressStartedAt.m_1, 1000);

	// Subsequent upsert preserves initial startedAt when progressStartedAt[matterId] already exists
	const progressUpdate: MatterProgressDto = {
		matterId: "m_1",
		stage: "tool",
		label: "执行工具",
	};
	useMatterRuntimeStore.getState().upsertMatterProgress("m_1", progressUpdate, 2000, "hi");
	assert.equal(useMatterRuntimeStore.getState().progressByMatter.m_1?.stage, "tool");
	assert.equal(useMatterRuntimeStore.getState().progressStartedAt.m_1, 1000);
	assert.equal(useMatterRuntimeStore.getState().streamingDelta, "hi");

	useMatterRuntimeStore.getState().appendStreamingDelta(" world");
	assert.equal(useMatterRuntimeStore.getState().streamingDelta, "hi world");

	useMatterRuntimeStore.getState().clearMatterProgress("m_1");
	assert.equal(useMatterRuntimeStore.getState().progressByMatter.m_1, undefined);
	assert.equal(useMatterRuntimeStore.getState().progressStartedAt.m_1, undefined);

	useMatterRuntimeStore.getState().upsertMatterProgress("m_2", { ...progressUpdate, matterId: "m_2" }, 3000);
	useMatterRuntimeStore.getState().setSseConnected(true);
	useMatterRuntimeStore.getState().resetRuntimeOnRevoke();
	const afterRevoke = useMatterRuntimeStore.getState();
	assert.deepEqual(afterRevoke.progressByMatter, {});
	assert.deepEqual(afterRevoke.progressStartedAt, {});
	assert.equal(afterRevoke.sseConnected, false);
	assert.equal(afterRevoke.streamingDelta, "");
});
