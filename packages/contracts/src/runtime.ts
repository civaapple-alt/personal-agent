import type { ActiveRunSnapshotDto, MatterDto, PendingDialogDto } from "./matter.ts";
import type { ModelSelection } from "./model-selection.ts";
import type {
	AccountUserDto,
	CollaboratorDto,
	OrganizationAiRoleConfigDto,
	OrganizationDto,
	OrganizationMemberDto,
	RegistrationMode,
	WebSearchProviderPreference,
} from "./organization.ts";
import type { RoleTemplateDto, TeamMemberDto } from "./team.ts";
import type { WorkspaceDto } from "./workspace.ts";

export type LocalPiResourcesPolicy = "auto" | "always" | "off";

export type RuntimeExtensionSourceKind =
	| "builtin"
	| "builtin_conditional"
	| "pi_builtin"
	| "operator_env"
	| "pi_package";

export type RuntimeExtensionStatus = "active" | "conditional" | "inactive" | "error";

export type RuntimeExtensionFileStatus = "present" | "missing" | "builtin" | "unknown";

export interface RuntimeExtensionDto {
	id: string;
	name: string;
	sourceKind: RuntimeExtensionSourceKind;
	status: RuntimeExtensionStatus;
	entryPath: string | null;
	fileStatus: RuntimeExtensionFileStatus;
	scopeSummary: string;
	description: string;
	registeredTools: string[];
	hooks: string[];
	declaredByRoles: string[];
	mcpServers: string[];
	error?: string | null;
}

export interface RuntimeIsolationModeDto {
	id: "worker" | "decision" | "architect-aux";
	label: string;
	usage: string;
	sessionStrategy: string;
	extensionsPolicy: string;
	toolsPolicy: string;
}

export interface RuntimeBaseInfoDto {
	name: string;
	executable: string;
	transport: string;
	available: boolean;
	version: string | null;
	probeError: string | null;
	nodeVersion: string;
	platform: string;
	pathsRedacted: boolean;
	sessionMode: "persisted" | "no_session";
	sessionDir: string | null;
	defaultCwd: string | null;
	webAccess: {
		installedVersion: string | null;
		roles: Array<{ id: string; name: string; enabled: boolean }>;
		provider?: WebSearchProviderPreference;
		effectiveProvider?: "deepseek" | "exa" | "kimi" | null;
	};
	systemOne?: {
		enabled: boolean;
	};
	isolationModes: RuntimeIsolationModeDto[];
	envFlags: {
		turnTimeoutMs: number;
		promptTimeoutMs: number;
		idleTimeoutMs: number;
		customExtensionsEnvConfigured: boolean;
	};
}

export interface RuntimeConfigItemDto {
	key: string;
	label: string;
	value: string;
	defaultValue?: string;
	overridden?: boolean;
}

export interface RuntimeConfigSectionDto {
	id: "env" | "paths" | "rpc" | "orchestrator";
	title: string;
	items: RuntimeConfigItemDto[];
}

export type ManagedEnvKey = "TYPESAFE_API_KEY" | "EXA_API_KEY" | "DEEPSEEK_API_KEY" | "MOONSHOT_API_KEY";

export interface ManagedEnvStatusDto {
	key: ManagedEnvKey;
	label: string;
	description: string;
	scope: "classifier" | "web_access";
	configured: boolean;
	source: "process_env" | "dotenv" | "unset";
}

export interface RuntimeOverviewDto {
	base: RuntimeBaseInfoDto;
	extensions: RuntimeExtensionDto[];
	configSections: RuntimeConfigSectionDto[];
	envCredentials?: ManagedEnvStatusDto[];
	summary: {
		activeCount: number;
		conditionalCount: number;
		operatorCount: number;
		inactiveCount: number;
		errorCount: number;
	};
	checkedAt: string;
}

export interface WebAccessTestResultDto {
	ok: boolean;
	provider: string | null;
	latencyMs: number;
	resultCount?: number;
	sampleTitles?: string[];
	error?: string;
}

export interface SystemOneTestResultDto {
	ok: boolean;
	enabled: boolean;
	latencyMs: number;
	answer?: string;
	error?: string;
}

export type PreviewServiceStatus = "starting" | "running" | "stopped" | "failed";

export interface PreviewServiceDto {
	id: string;
	title: string;
	url: string;
	port: number;
	cwd: string;
	command?: string;
	pid?: number | null;
	status: PreviewServiceStatus;
	matterId: string | null;
	startedAt?: string;
	error?: string;
}

export type WorkerSessionStatus = "active" | "idle" | "closed";

export interface WorkerSessionRecordDto {
	messageCursor: string | null;
	id: string;
	memberId: string;
	matterId: string;
	workspaceId: string | null;
	piSessionId: string | null;
	sessionFile: string | null;
	status: WorkerSessionStatus;
	lastActiveAt: string;
}

export interface BootstrapPayload {
	unifiedConversation?: boolean;
	authKind?: "session" | "loopback" | null;
	currentUser?: CollaboratorDto;
	accountUser?: AccountUserDto | null;
	platformPolicy?: {
		requireAuth?: boolean;
		registrationMode: RegistrationMode;
		allowLocalWorkspacePath: boolean;
		allowCommandPreviews: boolean;
		defaultModelSelection?: ModelSelection | null;
	};
	members: TeamMemberDto[];
	templates: RoleTemplateDto[];
	workspaces: WorkspaceDto[];
	organizations: OrganizationDto[];
	orgMembersByOrgId?: Record<string, OrganizationMemberDto[]>;
	orgAiRolesByOrgId?: Record<
		string,
		{
			configured: boolean;
			configs: OrganizationAiRoleConfigDto[];
			effectiveMemberIds: string[];
		}
	>;
	matters: MatterDto[];
	pendingDialogs: PendingDialogDto[];
	previews: PreviewServiceDto[];
	activeRuns?: Record<string, ActiveRunSnapshotDto>;
}
