import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Returns a referentially stable function that always calls the latest `fn`.
 * Use it for handlers passed to memoized children when the handler body reads frequently changing state.
 */
export function useStableCallback<Args extends unknown[], Result>(
	fn: (...args: Args) => Result,
): (...args: Args) => Result {
	const latest = useRef(fn);
	useLayoutEffect(() => {
		latest.current = fn;
	});
	return useCallback((...args: Args) => latest.current(...args), []);
}
