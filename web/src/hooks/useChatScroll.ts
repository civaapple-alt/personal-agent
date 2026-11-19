import { type UIEvent, useEffect, useLayoutEffect, useRef } from "react";

const MAX_SCROLL_MEMORY_ENTRIES = 100;
const chatScrollMemory = new Map<string, { scrollTop: number; atBottom: boolean }>();

function setScrollMemory(matterId: string, state: { scrollTop: number; atBottom: boolean }) {
	if (chatScrollMemory.has(matterId)) {
		chatScrollMemory.delete(matterId);
	}
	chatScrollMemory.set(matterId, state);
	if (chatScrollMemory.size > MAX_SCROLL_MEMORY_ENTRIES) {
		const oldestKey = chatScrollMemory.keys().next().value;
		if (oldestKey !== undefined) {
			chatScrollMemory.delete(oldestKey);
		}
	}
}

interface UseChatScrollOptions {
	activeLoadedId: string | null;
	messageCount: number;
	streamLen: number;
}

/** Manages per-matter scroll restoration and stick-to-bottom behavior during streaming updates. */
export function useChatScroll({ activeLoadedId, messageCount, streamLen }: UseChatScrollOptions) {
	const chatScrollRef = useRef<HTMLDivElement | null>(null);
	const chatStreamInnerRef = useRef<HTMLDivElement | null>(null);
	const messagesEndRef = useRef<HTMLDivElement | null>(null);
	const lastScrolledMatterIdRef = useRef<string | null>(null);
	const prevMessageCountRef = useRef(0);
	const prevStreamLenRef = useRef(0);

	useLayoutEffect(() => {
		const el = chatScrollRef.current;
		if (!el || !activeLoadedId) {
			lastScrolledMatterIdRef.current = null;
			prevMessageCountRef.current = 0;
			prevStreamLenRef.current = 0;
			return;
		}
		if (lastScrolledMatterIdRef.current !== activeLoadedId) {
			lastScrolledMatterIdRef.current = activeLoadedId;
			prevMessageCountRef.current = messageCount;
			prevStreamLenRef.current = streamLen;
			const saved = chatScrollMemory.get(activeLoadedId);
			if (saved && !saved.atBottom) {
				el.scrollTop = saved.scrollTop;
			} else {
				el.scrollTop = el.scrollHeight;
				setScrollMemory(activeLoadedId, { scrollTop: el.scrollTop, atBottom: true });
			}
			return;
		}
		const hadNewMessage = messageCount > prevMessageCountRef.current;
		const hadStreamGrowth = streamLen > prevStreamLenRef.current;
		prevMessageCountRef.current = messageCount;
		prevStreamLenRef.current = streamLen;
		if (!hadNewMessage && !hadStreamGrowth) return;
		const saved = chatScrollMemory.get(activeLoadedId);
		if (saved && !saved.atBottom) return;
		if (hadNewMessage) {
			messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
			setScrollMemory(activeLoadedId, { scrollTop: el.scrollHeight, atBottom: true });
		} else if (hadStreamGrowth) {
			el.scrollTop = el.scrollHeight;
			setScrollMemory(activeLoadedId, { scrollTop: el.scrollTop, atBottom: true });
		}
	}, [activeLoadedId, messageCount, streamLen]);

	useEffect(() => {
		const el = chatScrollRef.current;
		const inner = chatStreamInnerRef.current;
		if (!el || !inner || !activeLoadedId || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (lastScrolledMatterIdRef.current !== activeLoadedId) return;
			const saved = chatScrollMemory.get(activeLoadedId);
			if (saved && !saved.atBottom) return;
			el.scrollTop = el.scrollHeight;
			setScrollMemory(activeLoadedId, { scrollTop: el.scrollTop, atBottom: true });
		});
		observer.observe(inner);
		return () => observer.disconnect();
	}, [activeLoadedId]);

	const handleStreamScroll = (e: UIEvent<HTMLDivElement>) => {
		if (!activeLoadedId || lastScrolledMatterIdRef.current !== activeLoadedId) return;
		const el = e.currentTarget;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 100;
		setScrollMemory(activeLoadedId, { scrollTop: el.scrollTop, atBottom });
	};

	return {
		chatScrollRef,
		chatStreamInnerRef,
		messagesEndRef,
		handleStreamScroll,
	};
}
