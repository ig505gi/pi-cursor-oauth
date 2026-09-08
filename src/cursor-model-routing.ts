import type { CursorModelParameter } from "./cursor-wire";

export interface CursorModelRouting {
	modelId: string;
	parameters?: CursorModelParameter[];
	maxMode?: boolean;
}

const routingByPiModelId = new Map<string, CursorModelRouting>();

export function replaceCursorModelRouting(
	entries: Iterable<[string, CursorModelRouting]>,
): void {
	routingByPiModelId.clear();
	for (const [id, routing] of entries) {
		routingByPiModelId.set(id, routing);
	}
}

export function getCursorModelRouting(piModelId: string): CursorModelRouting {
	return routingByPiModelId.get(piModelId) ?? { modelId: piModelId };
}
