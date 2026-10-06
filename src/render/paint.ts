// Instance-color painting for hover highlighting, kept out of the renderer
// file to respect the size budget.

import { Color, InstancedMesh } from "three";
import type { Slot } from "./slot";

/** Paint the given slots with one color (instance colors batch-updated). */
export function paintSlots(
	noteMesh: InstancedMesh | null,
	ghostMesh: InstancedMesh | null,
	refs: Slot[],
	color: Color
): void {
	for (const ref of refs) {
		(ref.mesh === "note" ? noteMesh : ghostMesh)?.setColorAt(ref.local, color);
	}
	if (noteMesh?.instanceColor) noteMesh.instanceColor.needsUpdate = true;
	if (ghostMesh?.instanceColor) ghostMesh.instanceColor.needsUpdate = true;
}

/** Paint the given slots back to their stored base colors. */
export function restoreSlots(
	noteMesh: InstancedMesh | null,
	ghostMesh: InstancedMesh | null,
	refs: Slot[],
	noteBase: Float32Array,
	ghostBase: Float32Array
): void {
	for (const ref of refs) {
		const base = ref.mesh === "note" ? noteBase : ghostBase;
		if (base.length === 0) continue;
		paintSlots(noteMesh, ghostMesh, [ref], new Color(
			base[ref.local * 3],
			base[ref.local * 3 + 1],
			base[ref.local * 3 + 2]
		));
	}
}
