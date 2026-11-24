export function hasRoleProposalActions(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	return (
		("blueprints" in value && Array.isArray(value.blueprints) && value.blueprints.length > 0) ||
		("roleAdjustments" in value && Array.isArray(value.roleAdjustments) && value.roleAdjustments.length > 0)
	);
}
