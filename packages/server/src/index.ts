export { resolveBuiltinExtensionPath } from "./extensions/builtin-paths.ts";
export {
	builtinServerExtensions,
	findServerExtension,
	listServerExtensionSummaries,
	type ServerExtensionEntry,
} from "./extensions/registry.ts";
export {
	assessMatterInitiation,
	assessMatterInitiationWithModel,
	type CollaborationPresetMode,
	type DecisionConfidence,
	type InitiationAssessmentSource,
	type MatterInitiationAssessment,
	type MatterInitiationCandidate,
	type RoleFitStatus,
	type RoleGapSuggestion,
	validateInitiationModelDecision,
} from "./orchestrator/architect/matter-initiation.ts";
export {
	collectTeamFrictionDigest,
	type MetaArchitectBlueprintProposal,
	type MetaArchitectChatInput,
	type MetaArchitectChatResult,
	type MetaArchitectFormationSuggestion,
	type MetaArchitectHealthFinding,
	type MetaArchitectMessage,
	type MetaArchitectRoleAdjustment,
	parseMetaArchitectResponse,
	type RoleProposalPayload,
	runMetaArchitectChat,
} from "./orchestrator/architect/meta-architect.ts";
export {
	extractJsonObject,
	PiDecisionError,
	type PiDecisionErrorKind,
	type PiDecisionResult,
	type PiDecisionSpec,
	runTypedPiDecision,
} from "./orchestrator/architect/pi-decision.ts";
export {
	designRoleDraftWithModel,
	type RoleDesignDecisionPayload,
	validateRoleDesignDecision,
} from "./orchestrator/architect/role-design-decision.ts";
export { resolveRepoGitUserIdentity } from "./orchestrator/execution/execution-context.ts";
export {
	buildRuntimeOverview,
	type OrchestratorRuntimeConfig,
	type PiCliProbeResult,
	probePiCli,
	type RuntimeBaseInfo,
	type RuntimeConfigItem,
	type RuntimeConfigSection,
	type RuntimeExtensionFileStatus,
	type RuntimeExtensionItem,
	type RuntimeExtensionSourceKind,
	type RuntimeExtensionStatus,
	type RuntimeIsolationMode,
	type RuntimeOverviewPayload,
	type ServerRuntimeConfig,
} from "./orchestrator/runtime/runtime-info.ts";
export {
	buildProgressSnapshot,
	type DelegateInput,
	type DelegateResult,
	type DialogContext,
	type DispatchMatterInput,
	type DispatchMatterResult,
	type DispatchProgressEvent,
	type DistillExperiencesInput,
	type DistillExperiencesResult,
	type OrchestratorDialogHandler,
	type ProgressSnapshot,
	type PromptFileAttachment,
	type PromptImageAttachment,
	type RpcWorkerLike,
	TeamOrchestrator,
	type TeamOrchestratorOptions,
	type WorkerFactory,
} from "./orchestrator/team-orchestrator.ts";
export {
	applyRoleTemplatePatch,
	BUILTIN_ROLE_ARCHITECT_TEMPLATE,
	buildRoleDesignDraft,
	isArchitectRoleTemplate,
	normalizeRoleTools,
	ROLE_ARCHITECT_MEMBER_ID,
	type RoleArchitectDraft,
	type RoleDesignBriefInput,
	type RoleInteractionStyle,
	type RoleTemplatePatch,
	type RoleWorkspaceScope,
} from "./roles/role-architect.ts";
export {
	loadRoleTemplatesFromDir,
	loadRoleTemplatesWithCustomDir,
	parseRoleTemplateMarkdown,
	serializeRoleTemplateMarkdown,
} from "./roles/template-loader.ts";
export type { RoleTemplate, RoleTemplateSections } from "./roles/types.ts";
export { attachJsonlLineReader, serializeJsonLine } from "./rpc/jsonl.ts";
export {
	type DialogInteractionRecord,
	type ExtensionUiDialogHandler,
	type ExtensionUiNoticeListener,
	extractMessageText,
	PiRpcWorker,
	type PiRpcWorkerOptions,
	type PromptRunResult,
	type RunPromptOptions,
	type SessionEventListener,
	type ToolExecutionRecord,
} from "./rpc/pi-rpc-worker.ts";
export type * from "./rpc/types.ts";
export {
	createPersonalAgentServer,
	type PersonalAgentServerOptions,
} from "./server/app.ts";
export { type BootedHost, type BootHostOptions, bootHost } from "./server/boot.ts";
export {
	DialogBroker,
	type DialogEventListener,
	type PendingDialogEntry,
} from "./server/dialog-broker.ts";
export {
	PreviewManager,
	type PreviewServiceInfo,
	type StartPreviewInput,
} from "./server/preview-manager.ts";
export { openPersonalAgentDatabase } from "./storage/database.ts";
export {
	DEFAULT_LOCAL_ADMIN_USER_ID,
	DEFAULT_ORGANIZATION_ID,
	DEFAULT_ORGANIZATION_NAME,
	defaultMemberGitName,
	normalizeMemoryCategory,
	PersonalAgentStore,
	resolveEffectiveGitIdentity,
	slugifyOrganizationName,
	toPublicUser,
} from "./storage/repositories.ts";
export type * from "./storage/types.ts";
