import type { ReviewCriterion } from "./publication-review-case.ts";

export const SELECTION_IDS = ["how", "why", "teach", "recall", "architect"] as const;
export type SelectionId = (typeof SELECTION_IDS)[number];
export interface SelectionCase {
	id: SelectionId;
	memberId: "engineering-manager" | "product-manager";
	prompt: string;
	priorMessage?: string;
	rubric: ReviewCriterion[];
}

/** Candidate-facing files contain application context, never the selection rubric. */
export const selectionFiles = {
	"README.md":
		"# Feedback Desk\nA small feedback intake service. src/http.mjs accepts text and an Idempotency-Key. src/intake.mjs handles retries before saving through src/store.mjs. Storage and the retry cache are in process memory, not a database. No UI or external integrations are implemented.\nSee docs/decisions.md for the rationale and docs/ideas.md for unapproved ideas.\n",
	"src/http.mjs":
		"import { accept } from './intake.mjs';\nexport function submit(body, headers, actor, state, now) {\n  if (typeof body.text !== 'string' || !body.text.trim()) return {status:422, error:'text_required'};\n  const key = headers['idempotency-key'];\n  if (typeof key !== 'string' || !key.trim()) return {status:400, error:'key_required'};\n  const result = accept({actor, key, text:body.text.trim()}, state, now);\n  return {status:result.replayed ? 200 : 201, body:result.row};\n}\n",
	"src/intake.mjs":
		"const WINDOW_MS = 300000;\nexport function accept(input, state, now) {\n  const cacheKey = JSON.stringify([input.actor, input.key]);\n  const previous = state.retries.get(cacheKey);\n  if (previous && previous.expiresAt > now) return {row:previous.row, replayed:true};\n  const row = state.save(input);\n  state.retries.set(cacheKey, {row, expiresAt:now + WINDOW_MS});\n  return {row, replayed:false};\n}\n",
	"src/store.mjs":
		"export function createState() {\n  const rows = [];\n  return {rows, retries:new Map(), save(input) { const row = {id:rows.length + 1, ...input}; rows.push(row); return row; }};\n}\n",
	"docs/decisions.md":
		"# Recorded decisions\n\n## Retry protection\nWe originally keyed retries only by the caller-supplied key. Different users can choose the same key, so the later change scopes it by actor plus key. This protects separate users from accidentally receiving each other's result.\n\nFive minutes is an initial hypothesis, not a value derived from production data. It aims to cover short transport retries without promising permanent duplicate detection. The cache is in memory: after process restart, expiry or on another process, it does not guarantee suppression. Old expired entries are overwritten for the same key but there is currently no periodic cleanup for abandoned keys, so bounded retention is not yet bounded memory use.\n\nThe HTTP 201 means a row was accepted into this process; it does not prove persistence or delivery to an external system. Requests reusing the same actor/key during the window return the original row even if their submitted text differs. Concurrency and multi-process correctness have not been verified.\n",
	"docs/ideas.md":
		"# Unapproved ideas\nEarlier suggestions: automatic merging of similar feedback, English UI, external synchronization, a 30-person pilot and a 3000-yuan budget. These are proposals only, not decisions or implemented features. The repository has no approval record for them.\n",
} satisfies Record<string, string>;

export const earlierIntake = selectionFiles["src/intake.mjs"].replace(
	"JSON.stringify([input.actor, input.key])",
	"input.key",
);

export const selectionCases: SelectionCase[] = [
	{
		id: "how",
		memberId: "engineering-manager",
		prompt:
			"我刚接手这个反馈服务。请沿着实际代码解释：一个提交请求从入口到重试缓存、保存、返回结果，完整经过哪些步骤？给首次提交、短时间内重试和过期后再提交各举一个例子，说明它现在能保证什么、不能保证什么。引用具体文件，不改文件、不提交、不发布成果。",
		rubric: [
			{ id: "flow", question: "是否依据实际文件讲清 HTTP 校验、actor/key 缓存、保存及 201/200 返回路径？" },
			{ id: "scope", question: "例子是否符合五分钟、同一用户与键、过期重建的规则，且不把相同正文当去重键？" },
			{ id: "limits", question: "是否明确进程内内存、重启/多进程和持久化限制，不宣称永久去重或已经验证并发安全？" },
		],
	},
	{
		id: "why",
		memberId: "engineering-manager",
		prompt:
			"这个服务为什么要把重试缓存按用户区分，而且只保留五分钟？最初就是这样设计的吗？请结合仓库中的记录解释原因和取舍，特别说明五分钟是否有实际数据支撑。把记录能证明的事实、你自己的推断和暂时不知道的部分分开。只调查，不改文件、不提交、不发布成果。",
		rubric: [
			{
				id: "history",
				question: "是否检查实际 Git 记录或前后代码，并准确指出从仅 key 改为 actor/key，以避免跨用户串用结果？",
			},
			{ id: "basis", question: "是否明确五分钟是初始假设而非生产统计结论，且引用决策记录区分证据和推断？" },
			{ id: "tradeoff", question: "是否说明短期重试与永久去重的区别，且不把过期条件说成已实现自动清理或持久保障？" },
		],
	},
	{
		id: "teach",
		memberId: "product-manager",
		prompt:
			"我没有编程背景，想真正弄懂这个反馈服务：幂等键到底是什么，它和两条反馈文字相同有什么区别？用贴近用户操作的例子讲清一次提交、重复点击和过一会再提交的区别。也请解释，为什么看到成功提示仍不代表数据一定能长期找回。依据当前实现来讲，不改文件、不发布成果。",
		rubric: [
			{
				id: "meaning",
				question: "是否用易懂例子准确区分请求身份键、相同正文和重复点击，不让读者误以为系统自动识别相似反馈？",
			},
			{ id: "examples", question: "用户操作例子是否符合 actor/key 和五分钟窗口，尤其同一键不同正文会返回旧结果？" },
			{
				id: "durability",
				question: "是否准确解释内存保存、进程重启及成功提示的边界，而非声称已落盘或已同步外部系统？",
			},
		],
	},
	{
		id: "recall",
		memberId: "product-manager",
		priorMessage:
			"我们刚定下来：首版不做自动合并，相似内容先由人判断；同一用户和幂等键五分钟内只避免重复入库，超期不承诺去重。试点只用中文界面，先找 12 人，预算上限 800 元，暂不接外部服务。这轮先记住这些决定，不写文件、不发布成果，也不要开始实现。",
		prompt:
			"我回来继续推进这个反馈服务。帮我找回上次已经定下来的范围、试点人数和预算，再结合当前仓库说说哪些已经实现、哪些只是想法，下一步还有什么需要确认。别把早期提议当成已批准的决定，不改文件、不提交、不发布成果。",
		rubric: [
			{ id: "continuity", question: "是否恢复上轮实际决定：不自动合并、中文、12 人、800 元、不接外部服务？" },
			{
				id: "conflicts",
				question: "是否把旧草案的 30 人、3000 元、英文和自动合并标为未批准，并优先保留最近对话的明确决定？",
			},
			{
				id: "state",
				question: "是否区分当前内存服务已实现与 UI/合并/外部同步未实现，并保留未知项，不虚构已完成工作？",
			},
		],
	},
	{
		id: "architect",
		memberId: "engineering-manager",
		prompt:
			"我们准备让这个反馈服务把每条反馈通知到两个外部系统。对方可能超时，重试不能重复通知，而且当前五分钟内存缓存不能当作跨重启的保障。请先给出技术设计：划清模块责任，列出关键数据、状态和接口，比较两种可行方案及取舍，说明需要新增但还没实现的部分。只做设计，不改文件、不启动外部服务、不提交、不发布成果。",
		rubric: [
			{
				id: "shape",
				question: "是否给出清楚的职责、接口、数据身份及每个外部目标独立的通知状态，而非笼统要求加队列？",
			},
			{
				id: "recovery",
				question:
					"设计是否处理超时不确定、重试、重启恢复与目标端去重边界，不用进程内五分钟缓存冒充持久恰好一次保障？",
			},
			{
				id: "honesty",
				question: "是否比较至少两种有实质差别的方案，并明确均为拟议设计，不虚构当前已经有持久数据库或外部集成？",
			},
		],
	},
];
