import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect, createServer } from "node:net";

export interface PreviewServiceInfo {
	id: string;
	title: string;
	url: string;
	port: number;
	cwd: string;
	command: string;
	pid: number | null;
	status: "starting" | "running" | "stopped" | "failed";
	matterId: string | null;
	startedAt: string;
	error?: string;
}

interface ManagedPreview {
	info: PreviewServiceInfo;
	child: ChildProcess | null;
	logs: string[];
}

export interface StartPreviewInput {
	id?: string;
	title: string;
	command: string;
	args?: string[];
	cwd?: string;
	port?: number;
	matterId?: string | null;
	startupTimeoutMs?: number;
}

async function findFreePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Failed to allocate an ephemeral port"));
				return;
			}
			const { port } = address;
			server.close((err) => {
				if (err) reject(err);
				else resolve(port);
			});
		});
	});
}

async function waitForPortListening(port: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const connected = await new Promise<boolean>((resolve) => {
			const socket = connect({ host: "127.0.0.1", port });
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => {
				socket.destroy();
				resolve(false);
			});
		});
		if (connected) {
			return true;
		}
		await new Promise((r) => setTimeout(r, 80));
	}
	return false;
}

/**
 * Manages independent local preview processes, optionally scoped to a matter.
 */
export class PreviewManager {
	private readonly services = new Map<string, ManagedPreview>();

	listPreviews(): PreviewServiceInfo[] {
		return [...this.services.values()].map((entry) => ({ ...entry.info }));
	}

	getPreview(id: string): PreviewServiceInfo | null {
		const entry = this.services.get(id);
		return entry ? { ...entry.info } : null;
	}

	getLogs(id: string): string[] {
		return [...(this.services.get(id)?.logs ?? [])];
	}

	registerExternalPreview(input: {
		id?: string;
		title: string;
		url: string;
		port?: number;
		cwd?: string;
		matterId?: string | null;
	}): PreviewServiceInfo {
		const id = input.id ?? `prev_${randomUUID()}`;
		const parsedUrl = new URL(input.url);
		const port = input.port ?? (parsedUrl.port ? Number(parsedUrl.port) : 80);
		const info: PreviewServiceInfo = {
			id,
			title: input.title,
			url: input.url,
			port,
			cwd: input.cwd ?? process.cwd(),
			command: "external",
			pid: null,
			status: "running",
			matterId: input.matterId ?? null,
			startedAt: new Date().toISOString(),
		};
		this.services.set(id, { info, child: null, logs: [] });
		return { ...info };
	}

	async startCommandPreview(input: StartPreviewInput): Promise<PreviewServiceInfo> {
		const id = input.id ?? `prev_${randomUUID()}`;
		const port = input.port ?? (await findFreePort());
		const cwd = input.cwd ?? process.cwd();
		const url = `http://127.0.0.1:${port}`;

		const info: PreviewServiceInfo = {
			id,
			title: input.title,
			url,
			port,
			cwd,
			command: [input.command, ...(input.args ?? [])].join(" "),
			pid: null,
			status: "starting",
			matterId: input.matterId ?? null,
			startedAt: new Date().toISOString(),
		};

		const child = spawn(input.command, input.args ?? [], {
			cwd,
			env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
			stdio: ["ignore", "pipe", "pipe"],
		});

		info.pid = child.pid ?? null;
		const managed: ManagedPreview = { info, child, logs: [] };
		this.services.set(id, managed);

		const appendLog = (chunk: Buffer | string) => {
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			for (const line of text.split(/\r?\n/)) {
				if (line.length > 0) {
					managed.logs.push(line);
					if (managed.logs.length > 200) {
						managed.logs.shift();
					}
				}
			}
		};

		child.stdout?.on("data", appendLog);
		child.stderr?.on("data", appendLog);
		child.once("exit", (code, signal) => {
			if (managed.info.status !== "stopped") {
				managed.info.status = code === 0 ? "stopped" : "failed";
				if (code !== 0) {
					managed.info.error = `Exited with code=${code}, signal=${signal}`;
				}
			}
			managed.child = null;
		});

		const ready = await waitForPortListening(port, input.startupTimeoutMs ?? 5000);
		if (managed.info.status === "failed") {
			throw new Error(managed.info.error ?? `Preview process failed to start: ${info.command}`);
		}
		if (!ready) {
			await this.stopPreview(id);
			managed.info.status = "failed";
			managed.info.error = `Preview service did not listen on ${url} within timeout`;
			throw new Error(managed.info.error);
		}

		managed.info.status = "running";
		return { ...managed.info };
	}

	async stopPreview(id: string): Promise<PreviewServiceInfo | null> {
		const managed = this.services.get(id);
		if (!managed) return null;

		managed.info.status = "stopped";
		const child = managed.child;
		if (child && child.exitCode === null) {
			await new Promise<void>((resolve) => {
				let settled = false;
				const finish = () => {
					if (settled) return;
					settled = true;
					clearTimeout(killTimer);
					resolve();
				};

				child.once("exit", finish);
				child.kill("SIGTERM");
				const killTimer = setTimeout(() => {
					if (child.exitCode === null) {
						child.kill("SIGKILL");
					}
					finish();
				}, 1500);
			});
		}

		managed.child = null;
		return { ...managed.info };
	}

	async stopAll(): Promise<void> {
		const ids = [...this.services.keys()];
		await Promise.all(ids.map((id) => this.stopPreview(id)));
	}
}
