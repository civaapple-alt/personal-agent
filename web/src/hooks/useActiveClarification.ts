import { useMemo } from "react";
import {
	type HumanDecision,
	isCurrentHumanDecision,
	readHumanDecision,
} from "../../../src/orchestrator/human-decision.ts";
import type { AccountUserDto, CollaboratorDto, MatterDetailPayload, OrganizationDto } from "../api.ts";

export interface ActiveClarificationTarget {
	messageId: string;
	decision: HumanDecision;
	requestedBy: string;
}

/** Projects the latest pending, answerable human decision for the floating clarification dock above the composer. */
export function useActiveClarification({
	matterDetail,
	organizations,
	isSuperAdmin,
	accountUser,
	canManageMatter,
	currentUser,
	memberName,
}: {
	matterDetail: MatterDetailPayload | null;
	organizations: OrganizationDto[];
	isSuperAdmin: boolean;
	accountUser?: AccountUserDto | null;
	canManageMatter: boolean;
	currentUser?: CollaboratorDto | null;
	memberName: (id: string) => string;
}): ActiveClarificationTarget | null {
	return useMemo(() => {
		if (!matterDetail) return null;
		const orgRole = organizations.find((o) => o.id === matterDetail.matter.orgId)?.orgRole;
		const canParticipate = isSuperAdmin || orgRole !== "org_viewer";
		if (!canParticipate) return null;
		for (let i = matterDetail.userMessages.length - 1; i >= 0; i -= 1) {
			const msg = matterDetail.userMessages[i]!;
			const decision = readHumanDecision(msg.metadata);
			if (!decision || decision.status !== "pending") continue;
			if (!isCurrentHumanDecision(msg, decision, matterDetail.matter, matterDetail.userMessages.slice(i + 1))) {
				continue;
			}
			const canAnswer = decision.assignedUserId
				? accountUser?.id === decision.assignedUserId
				: canManageMatter && (accountUser != null || currentUser?.permissionRole === "owner");
			if (!canAnswer) continue;
			return {
				messageId: msg.id,
				decision,
				requestedBy: memberName(msg.senderId),
			};
		}
		return null;
	}, [matterDetail, organizations, isSuperAdmin, accountUser, canManageMatter, currentUser, memberName]);
}
