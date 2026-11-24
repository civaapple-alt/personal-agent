export interface BoundaryViolation {
	file: string;
	specifier: string;
	reason: string;
}

export function extractSpecifiers(source: string): string[];
export function checkImportEdge(rootDir: string, fileRel: string, specifier: string): string | null;
export function checkModuleBoundaries(rootDir: string): {
	filesChecked: number;
	violations: BoundaryViolation[];
};
