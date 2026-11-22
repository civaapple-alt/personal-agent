import type { AccountUserDto, RegistrationMode } from "./auth.ts";
import { requestJson } from "./client.ts";
import type { PreviewServiceDto } from "./deliverables.ts";
import type { MemberMemoryDto } from "./experiences.ts";
import type { ActiveRunSnapshotDto, MatterDto, PendingDialogDto } from "./matters.ts";
import type {
	CollaboratorDto,
	OrganizationAiRoleConfigDto,
	OrganizationDto,
	OrganizationMemberDto,
	WorkspaceDto,
} from "./organizations.ts";
import type { RoleTemplateDto, TeamMemberDto } from "./team.ts";

export interface BootstrapPayload {
	innerDemoAvailable?: boolean;
	unifiedConversation?: boolean;
	authKind?: "session" | "loopback" | null;
	currentUser?: CollaboratorDto;
	accountUser?: AccountUserDto | null;
	platformPolicy?: {
		requireAuth?: boolean;
		registrationMode: RegistrationMode;
		allowLocalWorkspacePath: boolean;
		allowCommandPreviews: boolean;
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
	memoriesByMember: Record<string, MemberMemoryDto[]>;
	activeRuns?: Record<string, ActiveRunSnapshotDto>;
}

export function fetchBootstrap(): Promise<BootstrapPayload> {
	return requestJson<BootstrapPayload>("/api/bootstrap");
}
