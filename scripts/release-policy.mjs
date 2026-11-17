/** Source-snapshot checks shared by local audits and the release packager. */
export function forbiddenReleasePath(path) {
	if (/^(?:\.data|\.pi|\.releases|node_modules|dist|web\/dist)(?:\/|$)/.test(path)) return true;
	if (/(?:^|\/)\.env(?:\..+)?$/.test(path)) return !/\.example$/.test(path);
	return (
		/(?:^|\/)(?:\.npmrc|credentials\.json|id_rsa|id_ed25519)$/.test(path) ||
		/\.(?:sqlite(?:3)?|db)(?:-(?:wal|shm))?$/.test(path)
	);
}

/** Return rule IDs and line numbers only; never return matching credential text. */
export function secretIndicators(bytes) {
	const text = bytes.toString("utf8");
	const rules = [
		["private-key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
		["openai-style-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g],
		["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
		["aws-access-key-id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
		["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
	];
	const findings = [];
	for (const [rule, pattern] of rules) {
		for (const match of text.matchAll(pattern))
			findings.push({ rule, line: text.slice(0, match.index).split("\n").length });
	}
	return findings;
}
