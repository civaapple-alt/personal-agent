import type { DialogContext } from "../orchestrator/team-orchestrator.ts";
import type { RpcExtensionUIDialogRequest, RpcExtensionUIResponsePayload } from "../rpc/types.ts";

export interface PendingDialogEntry {
	id: string;
	matterId: string;
	memberId: string;
	memberName: string;
	request: RpcExtensionUIDialogRequest;
	createdAt: string;
}

interface PendingWaiter {
	entry: PendingDialogEntry;
	resolve: (payload: RpcExtensionUIResponsePayload) => void;
}

export type DialogEventListener = (
	event:
		| { type: "dialog_requested"; dialog: PendingDialogEntry }
		| { type: "dialog_resolved"; dialogId: string; matterId: string; payload: RpcExtensionUIResponsePayload },
) => void;

/**
 * Bridges synchronous/blocking `PiRpcWorker` extension UI dialogs with
 * asynchronous HTTP + SSE user responses in the V4 workbench.
 */
export class DialogBroker {
	private readonly pending = new Map<string, PendingWaiter>();
	private readonly listeners = new Set<DialogEventListener>();

	onEvent(listener: DialogEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	listPending(matterId?: string): PendingDialogEntry[] {
		const entries = [...this.pending.values()].map((item) => item.entry);
		return matterId ? entries.filter((entry) => entry.matterId === matterId) : entries;
	}

	requestApproval(ctx: DialogContext): Promise<RpcExtensionUIResponsePayload> {
		const entry: PendingDialogEntry = {
			id: ctx.request.id,
			matterId: ctx.matterId,
			memberId: ctx.member.id,
			memberName: ctx.member.displayName,
			request: ctx.request,
			createdAt: new Date().toISOString(),
		};

		return new Promise<RpcExtensionUIResponsePayload>((resolve) => {
			this.pending.set(entry.id, { entry, resolve });
			for (const listener of [...this.listeners]) {
				listener({ type: "dialog_requested", dialog: entry });
			}
		});
	}

	respond(dialogId: string, payload: RpcExtensionUIResponsePayload): boolean {
		const waiter = this.pending.get(dialogId);
		if (!waiter) {
			return false;
		}
		this.pending.delete(dialogId);
		waiter.resolve(payload);
		for (const listener of [...this.listeners]) {
			listener({
				type: "dialog_resolved",
				dialogId,
				matterId: waiter.entry.matterId,
				payload,
			});
		}
		return true;
	}

	cancelAll(): void {
		for (const [id, waiter] of this.pending.entries()) {
			this.pending.delete(id);
			waiter.resolve({ cancelled: true });
		}
	}
}
