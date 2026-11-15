import { execFile } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { INNER_MATTER_GUIDE, type InnerMatterGuide } from "../demo/inner-matter-definition.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { Matter } from "../storage/types.ts";
import { HttpRequestError } from "./http.ts";

const execFileAsync = promisify(execFile);
export const INNER_MATTER_ID = "mat_builtin_feedback_box_v1";
const ORG_ID = "org-inner-demo";
const MEMBERS = ["product-manager", ...INNER_MATTER_GUIDE.collaborationMemberIds];
const FILES: Record<string, string> = {
	"README.md": `# 小团队反馈收集盒\n\n这是 Personal Agent 的内置演示工作区，所有用户与反馈均为虚构样本。\n\n从 docs/brief.md 了解背景，再读 docs/customer-notes.md。通过工作台的引导体验需求讨论、专业协作、阶段交付与反馈修订。阶段成果写入 deliverables/，初始目录没有预制成果。\n\n当前仅做产品与技术设计，不编码或部署，不需要安装依赖或提交 Git。工作区不是操作系统沙箱。\n`,
	"AGENTS.md": `# 演示工作约定\n\n这是虚构的小团队反馈收集盒。仅在当前工作区处理资料与成果，不读取其他业务仓库。\n\n产品经理负责澄清与整合；技术、测试咨询使用真实 delegate_to_member 工具，不在正文伪造同事回复。讨论不归档。明确形成阶段方案后，主负责人才能使用 publish_deliverable 发布 document，标题保持“反馈收集盒 · 产品方案”以形成版本系列。\n\n保留早期版本文件，修订说明变化及依据。本演示默认停留在设计阶段，不编码、不部署、不提交 Git。\n`,
	"docs/brief.md": `# 产品背景\n\n一个 5 人的小团队从邮件、即时消息与试用沟通中收到建议，常靠零散文本记录。负责人想有一处查看反馈并知道是否处理。\n\n## 已知目标\n\n- 首先方便负责人收集、回看和处理反馈。\n- 希望首版轻量，能够在本机试用。\n- 交付一份能供后续研发使用的产品与最小技术方案。\n\n## 尚需讨论\n\n谁来录入、首版处理到什么程度、是否需要账号和多人同时操作，均需先澄清。样本中的愿望不自动等于首版范围。\n`,
	"docs/customer-notes.md": `# 虚构试用访谈摘录\n\n这些是演示样本，不是真实客户证据或市场调研结论。\n\n- 小林，负责人：反馈分散在邮件和群聊里，经常想不起在哪里记过。\n- 阿南，研发：希望接到的是明确的问题和来源，不要只有一句“客户说不好用”。\n- 小周，测试：需要知道一个问题解决到哪一步，以及怎样确认处理完成。\n- 小林：首版最好简单些，先用起来再看哪些能力值得加。\n`,
	".gitignore": "node_modules/\n.env\n*.log\n.DS_Store\n",
};

/** Add missing seed files, without replacing work or resetting the demo Git repository. */
export async function prepareInnerMatterFiles(directory: string): Promise<void> {
	const root = resolve(directory);
	await mkdir(root, { recursive: true });
	for (const [name, content] of Object.entries(FILES)) {
		const path = join(root, name);
		await mkdir(dirname(path), { recursive: true });
		try {
			await writeFile(path, content, { flag: "wx" });
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
	}
	await mkdir(join(root, "deliverables"), { recursive: true });
	try {
		await lstat(join(root, ".git"));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
	}
}

/** Owns opt-in seeding; all real work remains on the ordinary matter dispatch path. */
export class InnerMatterDemo {
	private readonly store: PersonalAgentStore;
	private readonly directory: string;
	private preparing: Promise<Matter> | undefined;
	constructor(store: PersonalAgentStore, directory: string) {
		this.store = store;
		this.directory = resolve(directory);
	}

	guideFor(matter: Matter): InnerMatterGuide | undefined {
		if (matter.id !== INNER_MATTER_ID) return undefined;
		const workspace = matter.workspaceId ? this.store.getWorkspace(matter.workspaceId) : null;
		return workspace?.repoPath === this.directory && workspace.orgId === ORG_ID && matter.orgId === ORG_ID
			? INNER_MATTER_GUIDE
			: undefined;
	}

	prepare(): Promise<Matter> {
		if (this.preparing) return this.preparing;
		const operation = this.seed();
		this.preparing = operation;
		void operation
			.finally(() => {
				if (this.preparing === operation) this.preparing = undefined;
			})
			.catch(() => {});
		return operation;
	}

	private async seed(): Promise<Matter> {
		const missing = MEMBERS.filter((id) => !this.store.getMember(id));
		if (missing.length)
			throw new HttpRequestError(409, `演示需要产品经理、研发经理与测试经理，缺少：${missing.join("、")}`);
		const existing = this.store.getMatter(INNER_MATTER_ID);
		if (existing && !this.guideFor(existing))
			throw new HttpRequestError(409, "演示事项已修改组织或仓库，请保留现有工作并先恢复演示绑定");
		const registered = this.store.listWorkspaces().find((ws) => ws.repoPath === this.directory);
		if (registered && registered.orgId !== ORG_ID)
			throw new HttpRequestError(409, "演示目录已登记在其他组织中，未改写现有绑定");
		await prepareInnerMatterFiles(this.directory);
		if (this.store.listOrganizations().length === 0) this.store.ensureDefaultOrganization();
		if (!this.store.getOrganization(ORG_ID))
			this.store.upsertOrganization({ id: ORG_ID, name: "内置演示团队", isDefault: false });
		const workspace =
			registered ??
			this.store.upsertWorkspace({
				name: "内置演示 · 反馈收集盒",
				repoPath: this.directory,
				orgId: ORG_ID,
				description: "虚构演示资料与真实执行产生的阶段成果",
			});
		const matter =
			existing ??
			this.store.createMatter({
				id: INNER_MATTER_ID,
				title: "演示｜小团队反馈收集盒",
				workspaceId: workspace.id,
				orgId: ORG_ID,
				leadMemberId: "product-manager",
				aiMemberIds: MEMBERS,
				observersEnabled: false,
			});
		if (!this.store.listMessages(matter.id).some((msg) => msg.metadata?.innerMatterGuide === INNER_MATTER_GUIDE.id)) {
			this.store.appendMessage({
				matterId: matter.id,
				channel: "user",
				senderType: "system",
				senderId: "inner-demo",
				content:
					"演示资料已准备好。按上方引导填入提问，可以自行修改后发送给团队。打开演示不会调用模型；实际讨论、协作和成果会在执行后留下。",
				metadata: { innerMatterGuide: INNER_MATTER_GUIDE.id, workspaceId: workspace.id, repoPath: this.directory },
			});
		}
		return matter;
	}
}
