// Raycast picking for the three.js renderer: which node / hub sits under a
// client-space pointer position. Split out of three-renderer.ts to keep that
// file inside the size budget; pure function over the scene parts.

import { PerspectiveCamera, Raycaster, Vector2 } from "three";
import type { SceneParts } from "./scene-build";
import type { Slot } from "./slot";

export interface NodePick {
	slot: Slot;
	dist: number;
}

export interface HubPick {
	moduleId: string;
	count: number;
	dist: number;
}

export interface PickResult {
	node: NodePick | null;
	hub: HubPick | null;
}

export interface PickInput {
	el: HTMLElement;
	camera: PerspectiveCamera;
	parts: SceneParts;
	/** scratch vector, reused to avoid a per-frame allocation */
	ndc: Vector2;
}

export function pickAt(
	raycaster: Raycaster,
	input: PickInput,
	at: { x: number; y: number }
): PickResult {
	const { el, camera, parts, ndc } = input;
	const rect = el.getBoundingClientRect();
	ndc.set(
		((at.x - rect.left) / rect.width) * 2 - 1,
		-((at.y - rect.top) / rect.height) * 2 + 1
	);
	raycaster.setFromCamera(ndc, camera);

	let node: NodePick | null = null;
	const meshes: Array<[typeof parts.noteMesh, "note" | "ghost"]> = [
		[parts.noteMesh, "note"],
		[parts.ghostMesh, "ghost"],
	];
	for (const [mesh, kind] of meshes) {
		if (!mesh) continue;
		for (const hit of raycaster.intersectObject(mesh)) {
			if (hit.instanceId === undefined) continue;
			const list = kind === "note" ? parts.noteSlots : parts.ghostSlots;
			const slot = list[hit.instanceId] ?? null;
			if (slot && (!node || hit.distance < node.dist)) {
				node = { slot, dist: hit.distance };
			}
		}
	}

	// Hubs: the jellyfish bell is the pick target. Its filaments are children
	// of the bell, so they are never hit directly (line raycasting is both
	// unreliable and pointless for a decoration).
	let hub: HubPick | null = null;
	for (const jelly of parts.jellies) {
		for (const hit of raycaster.intersectObject(jelly.bell)) {
			if (!hub || hit.distance < hub.dist) {
				hub = {
					moduleId: jelly.moduleId,
					count: jelly.count,
					dist: hit.distance,
				};
			}
		}
	}

	return { node, hub };
}
