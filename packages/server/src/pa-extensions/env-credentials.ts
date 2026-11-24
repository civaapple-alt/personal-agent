import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

export const MANAGED_ENV_SPECS = [
	{
		key: "TYPESAFE_API_KEY",
		label: "System One 决策密钥",
		description: "用于工作台快速意图路由、名册识别与新事项参与建议；未配置时自动降级到 Pi 决策与本地规则。",
		scope: "classifier",
	},
	{
		key: "EXA_API_KEY",
		label: "Exa 网页检索密钥",
		description: "仅注入使用 pi-web-access 的岗位进程，用于公开网页搜索（自动优先级 #1）。",
		scope: "web_access",
	},
	{
		key: "DEEPSEEK_API_KEY",
		label: "DeepSeek 网页检索密钥",
		description:
			"仅注入使用 pi-web-access 的岗位进程，用于 DeepSeek Search API（api.deepseek.com/v1/tools/search，自动优先级 #2）。",
		scope: "web_access",
	},
	{
		key: "MOONSHOT_API_KEY",
		label: "Moonshot / Kimi 网页检索密钥",
		description: "仅注入使用 pi-web-access 的岗位进程，用于 Moonshot / Kimi 搜索（自动优先级 #3）。",
		scope: "web_access",
	},
] as const;

export type ManagedEnvKey = (typeof MANAGED_ENV_SPECS)[number]["key"];

export interface ManagedEnvStatus {
	key: ManagedEnvKey;
	label: string;
	description: string;
	scope: "classifier" | "web_access";
	configured: boolean;
	source: "process_env" | "dotenv" | "unset";
}

const MANAGED_KEY_SET = new Set<string>(MANAGED_ENV_SPECS.map((spec) => spec.key));

export function isManagedEnvKey(key: string): key is ManagedEnvKey {
	return MANAGED_KEY_SET.has(key);
}

export function resolveEnvFilePath(rootDir = process.cwd()): string {
	return resolve(rootDir, ".env");
}

export async function readDotEnvMap(envFilePath = resolveEnvFilePath()): Promise<Record<string, string>> {
	try {
		const raw = await readFile(envFilePath, "utf8");
		const parsed = parseEnv(raw);
		const result: Record<string, string> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === "string") result[key] = value;
		}
		return result;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
			return {};
		}
		return {};
	}
}

export async function listManagedEnvStatus(envFilePath = resolveEnvFilePath()): Promise<ManagedEnvStatus[]> {
	const dotEnv = await readDotEnvMap(envFilePath);
	return MANAGED_ENV_SPECS.map((spec) => {
		const inProcess = Boolean(process.env[spec.key]?.trim());
		const inDotEnv = Boolean(dotEnv[spec.key]?.trim());
		const source: ManagedEnvStatus["source"] = inProcess ? "process_env" : inDotEnv ? "dotenv" : "unset";
		return {
			key: spec.key,
			label: spec.label,
			description: spec.description,
			scope: spec.scope,
			configured: inProcess || inDotEnv,
			source,
		};
	});
}

/** Read only web-access provider keys from .env that are not already supplied by process.env. */
export async function readWebAccessEnvFromDotEnv(envFilePath = resolveEnvFilePath()): Promise<Record<string, string>> {
	const dotEnv = await readDotEnvMap(envFilePath);
	const env: Record<string, string> = {};
	for (const spec of MANAGED_ENV_SPECS) {
		if (spec.scope !== "web_access") continue;
		if (process.env[spec.key]?.trim()) continue;
		const value = dotEnv[spec.key]?.trim();
		if (value) env[spec.key] = value;
	}
	return env;
}

function formatDotEnvValue(value: string): string {
	if (/[\r\n]/.test(value)) {
		throw new Error("环境变量值不能包含换行符");
	}
	if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
	return JSON.stringify(value);
}

/** Update only whitelisted keys in .env while preserving unrelated lines and comments. */
export async function updateManagedDotEnv(
	envFilePath: string,
	updates: Partial<Record<ManagedEnvKey, string | null>>,
): Promise<void> {
	const entries = Object.entries(updates) as Array<[string, string | null | undefined]>;
	for (const [key, value] of entries) {
		if (!isManagedEnvKey(key)) throw new Error(`不支持修改环境变量：${key}`);
		if (value !== null && value !== undefined && typeof value !== "string") {
			throw new Error(`环境变量 ${key} 必须是字符串或 null`);
		}
		if (typeof value === "string" && /[\r\n]/.test(value)) {
			throw new Error(`环境变量 ${key} 不能包含换行符`);
		}
	}

	let existing = "";
	try {
		existing = await readFile(envFilePath, "utf8");
	} catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
			throw error;
		}
	}

	const lines = existing ? existing.replace(/\r\n/g, "\n").split("\n") : [];
	if (lines.length > 0 && lines.at(-1) === "") lines.pop();

	const handled = new Set<string>();
	const nextLines: string[] = [];
	for (const line of lines) {
		const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
		const key = match?.[1];
		if (key && Object.hasOwn(updates, key)) {
			handled.add(key);
			const nextVal = updates[key as ManagedEnvKey]?.trim() ?? "";
			if (nextVal) {
				nextLines.push(`${key}=${formatDotEnvValue(nextVal)}`);
			}
			continue;
		}
		nextLines.push(line);
	}

	for (const [key, rawValue] of entries) {
		if (handled.has(key)) continue;
		const nextVal = rawValue?.trim() ?? "";
		if (nextVal) {
			nextLines.push(`${key}=${formatDotEnvValue(nextVal)}`);
		}
	}

	const content = nextLines.length > 0 ? `${nextLines.join("\n")}\n` : "";
	await writeFile(envFilePath, content, { encoding: "utf8", mode: 0o600 });
	try {
		await chmod(envFilePath, 0o600);
	} catch {
		// Ignore chmod failures on non-POSIX filesystems.
	}
}
