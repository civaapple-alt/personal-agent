export interface PstackRuntime {
	root: string;
	version: string;
	modePath: string;
	modeSha256: string;
	skills: Array<{ name: string; description: string }>;
}

export function readPstackResource(
	root: string,
	name: string,
	resource?: string,
): Promise<{ name: string; resource: string; path: string; sha256: string; text: string }>;

export function preparePstackRuntime(directory: string): Promise<PstackRuntime>;
