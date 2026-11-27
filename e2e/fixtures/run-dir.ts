import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface E2eRunSummaryInput {
	verdict: "PASS" | "REVIEW_PENDING" | "FAIL";
	exitCode?: number;
	durationMs: number;
	profile?: string | null;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	verifierProvider?: string;
	verifierModel?: string;
	matterId?: string | null;
	artifacts?: Record<string, unknown>;
	error?: string;
}

export interface E2eRunDir {
	seq: number;
	seqLabel: string;
	runId: string;
	scenario: string;
	dir: string;
	dbDir: string;
	dbPath: string;
	spacesDir: string;
	sessionsDir: string;
	workspacesRoot: string;
	workspaceDir: string;
	logsDir: string;
	metaPath: string;
	runsLogPath: string;
	recordResult: (summary: E2eRunSummaryInput) => void;
}

function formatCompactTimestamp(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
		"-",
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds()),
	].join("");
}

function nextRunSequence(runsRoot: string): number {
	if (!existsSync(runsRoot)) return 1;
	let maxSeq = 0;
	for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const match = /^(\d+)-/.exec(entry.name);
		if (match) {
			const n = Number(match[1]);
			if (Number.isInteger(n) && n > maxSeq) maxSeq = n;
		}
	}
	return maxSeq + 1;
}

/** Allocate a numbered persistent run directory under `.data-e2e/runs/<NNN>-<scenario>-<ts>/`. */
export function createE2eRunDir(
	scenario: string,
	rootDir: string,
	initialMeta: Record<string, unknown> = {},
): E2eRunDir {
	const dataE2eRoot = resolve(rootDir, ".data-e2e");
	const runsRoot = join(dataE2eRoot, "runs");
	const runsLogPath = join(dataE2eRoot, "runs.jsonl");
	mkdirSync(runsRoot, { recursive: true });

	const seq = nextRunSequence(runsRoot);
	const seqLabel = String(seq).padStart(3, "0");
	const safeScenario = scenario.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "run";
	const stamp = formatCompactTimestamp(new Date());
	const runId = `${seqLabel}-${safeScenario}-${stamp}`;
	const dir = join(runsRoot, runId);

	const dbDir = join(dir, "db");
	const dbPath = join(dbDir, "personal-agent.db");
	const spacesDir = join(dir, "spaces");
	const sessionsDir = join(dir, "sessions");
	const workspacesRoot = join(dir, "team-workspaces");
	const workspaceDir = join(dir, "workspace");
	const logsDir = join(dir, "logs");
	const metaPath = join(dir, "run-meta.json");

	for (const sub of [dbDir, spacesDir, sessionsDir, workspacesRoot, workspaceDir, logsDir]) {
		mkdirSync(sub, { recursive: true });
	}

	const createdAt = new Date().toISOString();
	writeFileSync(
		metaPath,
		`${JSON.stringify({ seq, runId, scenario, createdAt, status: "running", ...initialMeta }, null, 2)}\n`,
		"utf8",
	);

	return {
		seq,
		seqLabel,
		runId,
		scenario,
		dir,
		dbDir,
		dbPath,
		spacesDir,
		sessionsDir,
		workspacesRoot,
		workspaceDir,
		logsDir,
		metaPath,
		runsLogPath,
		recordResult: (summary) => {
			const finishedAt = new Date().toISOString();
			const fullRecord = {
				seq,
				runId,
				scenario,
				createdAt,
				finishedAt,
				runDir: dir,
				...initialMeta,
				...summary,
			};
			writeFileSync(metaPath, `${JSON.stringify({ ...fullRecord, status: "finished" }, null, 2)}\n`, "utf8");
			appendFileSync(runsLogPath, `${JSON.stringify(fullRecord)}\n`, "utf8");
		},
	};
}
