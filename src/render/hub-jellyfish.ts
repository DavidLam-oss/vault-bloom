// Procedural jellyfish bells for the module hubs (PLAN Phase 2, "水母").
//
// This replaces the placeholder flat sphere. A flat sphere reads as a disc
// pasted onto the graph and occludes the nodes behind it; a lathe-built bell
// with a fade from apex to rim and a see-through DoubleSide surface reads as
// a volume instead, because you can see the far shell through the near one.
//
// Everything is procedural: geometry + vertex colours only. No textures, no
// custom shaders, no post-processing - which keeps the "zero external
// dependency" red line intact and lets the exact same code run in Obsidian
// and in the headless preview sandbox.
//
// Two animations, both cheap enough to run per frame for a handful of hubs:
//   - the bell contracts in a wave that travels apex -> rim (the swim pulse)
//   - the rim filaments sway tangentially with a per-filament phase offset

import {
	BufferAttribute,
	BufferGeometry,
	Color,
	DoubleSide,
	DynamicDrawUsage,
	LatheGeometry,
	LineBasicMaterial,
	LineSegments,
	Mesh,
	MeshBasicMaterial,
	Scene,
	Vector2,
} from "three";
import type { Palette } from "./palette";

/** Profile samples from apex to rim. */
const PROFILE_RINGS = 16;
/** Revolve resolution around the Y axis. */
const RADIAL_SEGMENTS = 28;
/** Rim angle past horizontal, so the bell tucks under like a real medusa. */
const THETA_MAX = Math.PI * 0.62;
const BELL_R = 0.85;
const BELL_H = 0.95;

/** Peak contraction of the swim pulse, as a fraction of the rest radius. */
const PULSE_AMP = 0.11;
/** Phase lag between apex and rim: this is what makes the wave travel. */
const PULSE_LAG = 1.7;
const PULSE_SPEED = 1.5;

const FILAMENTS = 14;
const FILAMENT_SEGMENTS = 9;
const FILAMENT_LEN = 1.6;
/** brightness of a filament tip, as a fraction of its rim brightness */
const FILAMENT_FADE = 0.1;
/** filament opacity, as a fraction of the palette edge opacity */
const FILAMENT_OPACITY = 0.55;

/**
 * Apex-to-rim brightness ramp.
 *
 * Deliberately brightest at the RIM, not at the apex. With additive blending
 * and a DoubleSide shell, the apex is where the near and far surfaces run
 * almost parallel, so it already accumulates the most fragments per pixel.
 * Lighting it brightest as well double-counts and the bell reads as a solid
 * cap. Running the ramp the other way evens out the accumulation and leaves
 * the silhouette to define the shape - which is what makes it read as a
 * translucent medusa rather than a mushroom.
 */
const APEX_BRIGHT = 0.55;
const RIM_BRIGHT = 1;

/**
 * A rendered module hub. `bell` is the raycast target; `filaments` is a child
 * of it (so it inherits position and scale) and is never picked.
 */
export interface Jellyfish {
	moduleId: string;
	count: number;
	bell: Mesh;
	filaments: LineSegments;
	/** rest positions of the bell, xyz per vertex */
	basePos: Float32Array;
	/** per bell vertex: distance from the apex, 0 = apex, 1 = rim */
	vertexT: Float32Array;
	filamentBase: Float32Array;
	filamentSwing: Float32Array;
	filamentAmp: Float32Array;
	filamentPhase: Float32Array;
	phase: number;
	baseOpacity: number;
	filamentBaseOpacity: number;
}

/** Bell world radius for a module of `count` notes. */
export function hubBellScale(count: number): number {
	return (7 + 2.0 * Math.sqrt(Math.max(1, count))) * 0.85;
}

export function createJellyfish(
	scene: Scene,
	moduleId: string,
	count: number,
	color: Color,
	palette: Palette,
	at: { x: number; y: number; z: number }
): Jellyfish {
	const { geometry, basePos, vertexT } = buildBell(color);
	const baseOpacity = palette.hubBaseOpacity;
	const filamentBaseOpacity = palette.edgeOpacity * FILAMENT_OPACITY;

	const bell = new Mesh(
		geometry,
		new MeshBasicMaterial({
			vertexColors: true,
			transparent: true,
			opacity: baseOpacity,
			depthWrite: false,
			side: DoubleSide,
			blending: palette.flowBlending,
			toneMapped: false,
		})
	);
	bell.position.set(at.x, at.y, at.z);
	bell.scale.setScalar(hubBellScale(count));

	const filaments = buildFilaments(color, filamentBaseOpacity, palette);
	// Child of the bell: inherits its transform, keeps `bell` a direct child
	// of the scene so picking stays a single intersectObject call.
	bell.add(filaments);
	scene.add(bell);

	return {
		moduleId,
		count,
		bell,
		filaments,
		basePos,
		vertexT,
		filamentBase: filaments.userData.basePos as Float32Array,
		filamentSwing: filaments.userData.swing as Float32Array,
		filamentAmp: filaments.userData.amp as Float32Array,
		filamentPhase: filaments.userData.phase as Float32Array,
		phase: Math.random() * Math.PI * 2,
		baseOpacity,
		filamentBaseOpacity,
	};
}

/**
 * Advance the swim pulse and the filament sway by `dt`. With motion disabled
 * (prefers-reduced-motion) the phase is frozen, which leaves the jellyfish
 * in a still, correctly-shaped pose rather than snapping to its rest state.
 */
export function updateJellyfish(
	j: Jellyfish,
	dt: number,
	motionEnabled: boolean
): void {
	if (motionEnabled) j.phase += dt * PULSE_SPEED;
	applyBellWave(j);
	applyFilamentWave(j);
}

/**
 * Opacity factor relative to the base: 1 = overview, >1 = focused, <1 = dimmed
 * by a module drill-down. Mirrors what the hub spheres used to do.
 */
export function setJellyfishOpacity(j: Jellyfish, factor: number): void {
	(j.bell.material as MeshBasicMaterial).opacity = Math.min(
		1,
		j.baseOpacity * factor
	);
	(j.filaments.material as LineBasicMaterial).opacity = Math.min(
		1,
		j.filamentBaseOpacity * factor
	);
}

export function disposeJellyfish(scene: Scene, j: Jellyfish): void {
	scene.remove(j.bell);
	j.bell.geometry.dispose();
	(j.bell.material as MeshBasicMaterial).dispose();
	j.filaments.geometry.dispose();
	(j.filaments.material as LineBasicMaterial).dispose();
}

// --- bell ------------------------------------------------------------------

/**
 * A bell silhouette revolved around Y. `vertexT` is kept alongside the
 * geometry because the swim wave is a function of the distance from the apex,
 * and LatheGeometry does not record that for us.
 */
function buildBell(color: Color): {
	geometry: LatheGeometry;
	basePos: Float32Array;
	vertexT: Float32Array;
} {
	const profile: Vector2[] = [];
	const ringT: number[] = [];
	for (let i = 0; i < PROFILE_RINGS; i++) {
		const t = i / (PROFILE_RINGS - 1);
		const theta = t * THETA_MAX;
		// Keep x strictly positive: a zero-radius ring makes degenerate normals.
		profile.push(
			new Vector2(
				Math.max(Math.sin(theta) * BELL_R, 0.002),
				Math.cos(theta) * BELL_H
			)
		);
		ringT.push(t);
	}

	const geometry = new LatheGeometry(profile, RADIAL_SEGMENTS);
	const position = geometry.getAttribute("position");
	const total = position.count;
	const perRing = RADIAL_SEGMENTS + 1;
	const basePos = Float32Array.from(position.array as Float32Array);
	const vertexT = new Float32Array(total);
	const colors = new Float32Array(total * 3);

	// LatheGeometry emits vertices ring by ring: ring * (segments + 1) + j.
	for (let i = 0; i < total; i++) {
		const ring = Math.min(PROFILE_RINGS - 1, Math.floor(i / perRing));
		vertexT[i] = ringT[ring];
		const b = APEX_BRIGHT + (RIM_BRIGHT - APEX_BRIGHT) * ringT[ring];
		colors[i * 3] = color.r * b;
		colors[i * 3 + 1] = color.g * b;
		colors[i * 3 + 2] = color.b * b;
	}
	geometry.setAttribute("color", new BufferAttribute(colors, 3));

	// The pulse only ever contracts the bell, but it stretches it vertically;
	// pad the bound so it stays a valid early-out for ray picking.
	geometry.computeBoundingSphere();
	if (geometry.boundingSphere) geometry.boundingSphere.radius *= 1.35;

	return { geometry, basePos, vertexT };
}

function applyBellWave(j: Jellyfish): void {
	const attr = j.bell.geometry.getAttribute("position") as BufferAttribute;
	const arr = attr.array as Float32Array;
	const { basePos, vertexT, phase } = j;
	for (let i = 0; i < vertexT.length; i++) {
		const swim = Math.sin(phase - vertexT[i] * PULSE_LAG);
		// Contraction only: never wider than the rest shape, so the bounding
		// sphere computed at build time stays a valid bound.
		const k = 1 - PULSE_AMP * (0.5 + 0.5 * swim);
		const o = i * 3;
		arr[o] = basePos[o] * k;
		// Contracting narrows the bell, so it stretches taller (2 - k >= 1).
		arr[o + 1] = basePos[o + 1] * (2 - k);
		arr[o + 2] = basePos[o + 2] * k;
	}
	attr.needsUpdate = true;
}

// --- rim filaments ---------------------------------------------------------

function buildFilaments(
	color: Color,
	opacity: number,
	palette: Palette
): LineSegments {
	const segments = FILAMENT_SEGMENTS;
	const vertexCount = FILAMENTS * segments * 2;
	const basePos = new Float32Array(vertexCount * 3);
	const swing = new Float32Array(vertexCount * 3);
	const amp = new Float32Array(vertexCount);
	const phase = new Float32Array(vertexCount);
	const colors = new Float32Array(vertexCount * 3);

	const rimR = BELL_R * Math.sin(THETA_MAX);
	const rimY = BELL_H * Math.cos(THETA_MAX);
	let v = 0;
	for (let k = 0; k < FILAMENTS; k++) {
		// Deterministic jitter keeps the fringe from looking machine-made
		// while staying reproducible across rebuilds.
		const hash = (k * 7919) % 100;
		const angle = (k / FILAMENTS) * Math.PI * 2 + 0.19 * Math.sin(k * 2.4);
		const cx = Math.cos(angle);
		const cz = Math.sin(angle);
		// Sway tangentially, not radially: radial sway would collide with the
		// hub-to-member tendrils that leave along the same direction.
		const tx = -cz;
		const tz = cx;
		const length = FILAMENT_LEN * (0.75 + 0.5 * (hash / 100));

		for (let s = 0; s < segments; s++) {
			for (let step = 0; step < 2; step++) {
				const p = (s + step) / segments;
				const outward = 1 + 0.45 * p;
				const o = v * 3;
				basePos[o] = cx * rimR * outward;
				basePos[o + 1] = rimY - p * length;
				basePos[o + 2] = cz * rimR * outward;
				swing[o] = tx;
				swing[o + 2] = tz;
				// Quadratic ramp: the filament is pinned at the rim and only
				// the free end travels.
				amp[v] = 0.34 * p * p;
				phase[v] = k * 1.7 + p * 3.1;
				const f = 1 - p * (1 - FILAMENT_FADE);
				colors[o] = color.r * f;
				colors[o + 1] = color.g * f;
				colors[o + 2] = color.b * f;
				v++;
			}
		}
	}

	const geometry = new BufferGeometry();
	geometry.setAttribute(
		"position",
		new BufferAttribute(basePos.slice(), 3).setUsage(DynamicDrawUsage)
	);
	geometry.setAttribute("color", new BufferAttribute(colors, 3));
	const material = new LineBasicMaterial({
		vertexColors: true,
		transparent: true,
		opacity,
		depthWrite: false,
		blending: palette.flowBlending,
	});
	const lines = new LineSegments(geometry, material);
	lines.frustumCulled = false;
	// Rest data the animation loop reads back.
	lines.userData.basePos = basePos;
	lines.userData.swing = swing;
	lines.userData.amp = amp;
	lines.userData.phase = phase;
	return lines;
}

function applyFilamentWave(j: Jellyfish): void {
	const attr = j.filaments.geometry.getAttribute("position") as BufferAttribute;
	const arr = attr.array as Float32Array;
	const { filamentBase, filamentSwing, filamentAmp, filamentPhase, phase } = j;
	for (let i = 0; i < filamentAmp.length; i++) {
		const s = Math.sin(phase * 1.15 + filamentPhase[i]) * filamentAmp[i];
		const o = i * 3;
		arr[o] = filamentBase[o] + filamentSwing[o] * s;
		arr[o + 1] = filamentBase[o + 1];
		arr[o + 2] = filamentBase[o + 2] + filamentSwing[o + 2] * s;
	}
	attr.needsUpdate = true;
}
