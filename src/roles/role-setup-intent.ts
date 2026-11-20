/** Recognize direct team configuration requests without treating a discussion or approval as authorization. */
export function isExplicitRoleSetupRequest(prompt: string): boolean {
	const instruction =
		prompt
			.trim()
			.split(/[。！？!?\n]|\.[ \t]/u, 1)[0]
			?.slice(0, 220) ?? "";
	const opening = /^(?:请\s*|帮我\s*|麻烦\s*|我想\s*|现在\s*|直接\s*|在(?:本|当前)事项(?:中|里)?\s*)+/u;
	const reference =
		/^(?:按照|按|根据|基于)[^，,:：]{1,38}?[，,:：]?\s*(?=在(?:本|当前)事项|把|将|创建|新建|新增|开通|注册|设计)/u;
	const action = instruction.replace(opening, "").replace(reference, "").replace(opening, "");
	if (/(?:角色|岗位)\s*的?\s*(?:功能|接口|按钮|页面)|\broles?\s+(?:feature|api|button|page)\b/iu.test(action)) {
		return false;
	}
	return (
		/^(?:创建|新建|新增|开通|注册|设计)[^，。！？]{0,55}(?:角色|岗位|AI\s*成员)/iu.test(action) ||
		/^(?:把|将)[^，。！？]{0,65}(?:角色|岗位|AI\s*成员)[^，。！？]{0,24}(?:创建|建好|新建|开通)/iu.test(action) ||
		/^(?:please\s+|help me\s+|now\s+)*(?:create|register|design|set up)\s+[^.!?]{0,75}\b(?:roles?|ai teammates?)\b/i.test(
			action,
		)
	);
}
