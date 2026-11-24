export interface StalledMember {
	memberId: string;
	memberName: string;
	assignmentNumber?: number;
	lastActivityAt: string;
	lastAction: string;
}

const DEFAULT_STALL_MS = 180_000;

/** Report stalled workers without intervening in the turn or counting known waits as stalls. */
export function createTurnMonitor(
	onChange: (active: StalledMember[], raised: StalledMember[]) => void,
	{ now = Date.now, delayMs = DEFAULT_STALL_MS }: { now?: () => number; delayMs?: number } = {},
) {
	interface WorkerState {
		member: Pick<StalledMember, "memberId" | "memberName" | "assignmentNumber">;
		lastAt: number;
		lastAction: string;
		tools: Set<string>;
		waits: number;
		alert?: StalledMember;
	}
	const workers = new Set<WorkerState>();
	let closed = false;
	const report = (raised: StalledMember[] = []) => {
		if (!closed)
			onChange(
				[...workers].flatMap(({ alert }) => (alert ? [alert] : [])),
				raised,
			);
	};
	const scan = () => {
		const at = now();
		const raised: StalledMember[] = [];
		for (const worker of workers) {
			if (worker.waits || worker.tools.size || worker.alert || at - worker.lastAt < delayMs) continue;
			const alert = {
				...worker.member,
				lastActivityAt: new Date(worker.lastAt).toISOString(),
				lastAction: worker.lastAction,
			};
			worker.alert = alert;
			raised.push(alert);
		}
		if (raised.length) report(raised);
	};
	const timer = setInterval(scan, Math.min(15_000, delayMs)).unref();
	return {
		scan,
		begin(member: WorkerState["member"]) {
			const state: WorkerState = { member, lastAt: now(), lastAction: "接入工作会话", tools: new Set(), waits: 0 };
			workers.add(state);
			const pulse = (action?: string) => {
				state.lastAt = now();
				if (action) state.lastAction = action;
				if (state.alert) {
					state.alert = undefined;
					report();
				}
			};
			return {
				pulse,
				toolStarted(id: string, label: string) {
					state.tools.add(id);
					pulse(label);
				},
				toolFinished(id: string, label: string) {
					state.tools.delete(id);
					pulse(label);
				},
				wait() {
					state.waits += 1;
					pulse();
					return () => {
						state.waits -= 1;
						pulse();
					};
				},
				stop() {
					workers.delete(state);
					if (state.alert) report();
				},
			};
		},
		close() {
			closed = true;
			clearInterval(timer);
			workers.clear();
		},
	};
}

export type TurnMonitor = ReturnType<typeof createTurnMonitor>;
