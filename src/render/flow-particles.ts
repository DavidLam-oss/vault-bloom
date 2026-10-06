// Flow layer (Phase 2, step 1): glowing particles streaming along edges
// plus jellyfish tendril lines from each module hub to its members.
// Ambient flow is slow; hovering a node boosts every segment touching it;
// module focus dims particles outside the focused module.
// CPU-updated THREE.Points: ~6k particles is well within frame budget and
// keeps the math simple until the jellyfish shader work lands.

import {
	AdditiveBlending,
	BufferAttribute,
	BufferGeometry,
	CanvasTexture,
	Color,
	DynamicDrawUsage,
	LineBasicMaterial,
	LineSegments,
	Points,
	PointsMaterial,
	Scene,
} from "three";

export interface FlowSegment {
	/** layout node index for end A, or -1 when A is a fixed point (hub) */
	aIdx: number;
	/** layout node index for end B */
	bIdx: number;
	aId: string | null;
	bId: string;
	/** hub coordinates, required when aIdx is -1 */
	fixedA?: { x: number; y: number; z: number };
	color: Color;
	kind: "link" | "ghost" | "tendril";
}

interface Seg {
	aIdx: number;
	bIdx: number;
	fixedA: { x: number; y: number; z: number } | null;
	aId: string | null;
	bId: string;
	color: Color;
	kind: "link" | "ghost" | "tendril";
	lenInv: number;
	particles: number;
	first: number;
	lineSlot: number;
}

const FLOW_SPEED = 16;
const HOVER_BOOST = 6;
const PARTICLES_PER: Record<FlowSegment["kind"], number> = {
	link: 2,
	ghost: 1,
	tendril: 1,
};
const MIN_BRIGHT = 0.18;
const FOCUS_DIM_PARTICLE = 0.12;
const FOCUS_DIM_TENDRIL = 0.1;

/**
 * Build the segment list for a scene rebuild: one segment per layout edge
 * (link/ghost) plus one tendril per note member whose module has a hub.
 * Pure data mapping, kept out of ThreeRenderer to respect the size budget.
 */
export function buildFlowSegments(
	layoutNodes: ReadonlyArray<{ id: string; moduleId: string }>,
	layoutEdges: ReadonlyArray<{ source: number; target: number; kind: string }>,
	nodeById: Map<string, { kind: string }>,
	hubs: Map<string, { x: number; y: number; z: number }>,
	moduleColor: (moduleId: string) => Color,
	linkColor: Color,
	ghostColor: Color
): FlowSegment[] {
	const segs: FlowSegment[] = layoutEdges.map((e) => ({
		aIdx: e.source,
		bIdx: e.target,
		aId: layoutNodes[e.source].id,
		bId: layoutNodes[e.target].id,
		color: e.kind === "ghost" ? ghostColor : linkColor,
		kind: e.kind === "ghost" ? "ghost" : "link",
	}));
	layoutNodes.forEach((sim, i) => {
		const hub = hubs.get(sim.moduleId);
		const node = nodeById.get(sim.id);
		if (!hub || !node || node.kind !== "note") return;
		segs.push({
			aIdx: -1,
			fixedA: hub,
			aId: null,
			bIdx: i,
			bId: sim.id,
			color: moduleColor(sim.moduleId).clone().multiplyScalar(0.9),
			kind: "tendril",
		});
	});
	return segs;
}

export class FlowLayer {
	private scene: Scene;
	private points: Points | null = null;
	private pointMat: PointsMaterial | null = null;
	private tendrils: LineSegments | null = null;
	private tendrilMat: LineBasicMaterial | null = null;
	private sprite: CanvasTexture | null = null;

	private segs: Seg[] = [];
	private travel = new Float64Array(0);
	private accel = new Float32Array(0);
	private dim = new Float32Array(0);
	private posArr = new Float32Array(0);
	private colArr = new Float32Array(0);
	private linePosArr = new Float32Array(0);

	constructor(scene: Scene) {
		this.scene = scene;
	}

	rebuild(
		segments: FlowSegment[],
		nodes: ReadonlyArray<{ x: number; y: number; z: number }>
	): void {
		this.disposeGeometry();
		this.segs = [];
		let total = 0;
		let tendrilCount = 0;
		for (const seg of segments) {
			const a = seg.aIdx >= 0 ? nodes[seg.aIdx] : seg.fixedA;
			if (!a) continue;
			const b = nodes[seg.bIdx];
			const len = Math.max(
				1,
				Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
			);
			const particles = PARTICLES_PER[seg.kind];
			this.segs.push({
				aIdx: seg.aIdx,
				bIdx: seg.bIdx,
				fixedA: seg.aIdx >= 0 ? null : seg.fixedA ?? null,
				aId: seg.aId,
				bId: seg.bId,
				color: seg.color,
				kind: seg.kind,
				lenInv: 1 / len,
				particles,
				first: total,
				lineSlot: seg.kind === "tendril" ? tendrilCount++ : -1,
			});
			total += particles;
		}
		if (total === 0) return;

		this.travel = new Float64Array(this.segs.length);
		this.accel = new Float32Array(this.segs.length).fill(1);
		this.dim = new Float32Array(this.segs.length).fill(1);
		this.posArr = new Float32Array(total * 3);
		this.colArr = new Float32Array(total * 3);

		const geo = new BufferGeometry();
		geo.setAttribute(
			"position",
			new BufferAttribute(this.posArr, 3).setUsage(DynamicDrawUsage)
		);
		geo.setAttribute(
			"color",
			new BufferAttribute(this.colArr, 3).setUsage(DynamicDrawUsage)
		);
		this.sprite = this.sprite ?? this.makeSprite();
		this.pointMat = new PointsMaterial({
			size: 3.2,
			sizeAttenuation: false,
			map: this.sprite,
			transparent: true,
			depthWrite: false,
			blending: AdditiveBlending,
			vertexColors: true,
		});
		this.points = new Points(geo, this.pointMat);
		this.points.frustumCulled = false;
		this.scene.add(this.points);

		if (tendrilCount > 0) {
			this.linePosArr = new Float32Array(tendrilCount * 6);
			const lineColArr = new Float32Array(tendrilCount * 6);
			for (const s of this.segs) {
				if (s.kind !== "tendril") continue;
				const c = s.color.clone().multiplyScalar(0.5);
				for (const v of [0, 1]) {
					lineColArr.set([c.r, c.g, c.b], (s.lineSlot * 2 + v) * 3);
				}
			}
			const lineGeo = new BufferGeometry();
			lineGeo.setAttribute(
				"position",
				new BufferAttribute(this.linePosArr, 3).setUsage(DynamicDrawUsage)
			);
			lineGeo.setAttribute("color", new BufferAttribute(lineColArr, 3));
			this.tendrilMat = new LineBasicMaterial({
				vertexColors: true,
				transparent: true,
				opacity: 0.15,
				depthWrite: false,
			});
			this.tendrils = new LineSegments(lineGeo, this.tendrilMat);
			this.tendrils.frustumCulled = false;
			this.scene.add(this.tendrils);
		}
	}

	/** Hover boost: every segment touching nodeId speeds up. */
	accelerate(nodeId: string | null): void {
		for (let i = 0; i < this.segs.length; i++) {
			const s = this.segs[i];
			this.accel[i] =
				nodeId !== null && (s.aId === nodeId || s.bId === nodeId)
					? HOVER_BOOST
					: 1;
		}
	}

	/** Module focus: dim particles whose segment leaves the member set. */
	setFocusDim(members: Set<string> | null): void {
		for (let i = 0; i < this.segs.length; i++) {
			const s = this.segs[i];
			if (!members) {
				this.dim[i] = 1;
			} else if (s.kind === "tendril") {
				this.dim[i] = members.has(s.bId) ? 1 : FOCUS_DIM_TENDRIL;
			} else {
				this.dim[i] =
					s.aId !== null && members.has(s.aId) && members.has(s.bId)
						? 1
						: FOCUS_DIM_PARTICLE;
			}
		}
	}

	/** Advance one frame; call every frame the scene renders. */
	update(
		dt: number,
		nodes: ReadonlyArray<{ x: number; y: number; z: number }>
	): void {
		if (!this.points) return;
		for (let i = 0; i < this.segs.length; i++) {
			const s = this.segs[i];
			const a = s.aIdx >= 0 ? nodes[s.aIdx] : s.fixedA;
			const b = nodes[s.bIdx];
			if (!a || !b) continue;
			this.travel[i] += dt * FLOW_SPEED * this.accel[i];
			const base = this.travel[i] * s.lenInv;
			const dim = this.dim[i];
			const cr = s.color.r;
			const cg = s.color.g;
			const cb = s.color.b;
			for (let k = 0; k < s.particles; k++) {
				let t = base + k / s.particles;
				t -= Math.floor(t);
				const o = (s.first + k) * 3;
				this.posArr[o] = a.x + (b.x - a.x) * t;
				this.posArr[o + 1] = a.y + (b.y - a.y) * t;
				this.posArr[o + 2] = a.z + (b.z - a.z) * t;
				const br =
					(MIN_BRIGHT + (1 - MIN_BRIGHT) * Math.sin(Math.PI * t)) * dim;
				this.colArr[o] = cr * br;
				this.colArr[o + 1] = cg * br;
				this.colArr[o + 2] = cb * br;
			}
			if (s.lineSlot >= 0) {
				const lo = s.lineSlot * 6;
				this.linePosArr[lo] = a.x;
				this.linePosArr[lo + 1] = a.y;
				this.linePosArr[lo + 2] = a.z;
				this.linePosArr[lo + 3] = b.x;
				this.linePosArr[lo + 4] = b.y;
				this.linePosArr[lo + 5] = b.z;
			}
		}
		const posAttr = this.points.geometry.getAttribute("position") as
			| BufferAttribute
			| undefined;
		if (posAttr) posAttr.needsUpdate = true;
		const colAttr = this.points.geometry.getAttribute("color") as
			| BufferAttribute
			| undefined;
		if (colAttr) colAttr.needsUpdate = true;
		if (this.tendrils) {
			const lineAttr = this.tendrils.geometry.getAttribute(
				"position"
			) as BufferAttribute | undefined;
			if (lineAttr) lineAttr.needsUpdate = true;
		}
	}

	dispose(): void {
		this.disposeGeometry();
		this.sprite?.dispose();
		this.sprite = null;
	}

	private disposeGeometry(): void {
		for (const obj of [this.points, this.tendrils]) {
			if (!obj) continue;
			this.scene.remove(obj);
			obj.geometry.dispose();
		}
		this.pointMat?.dispose();
		this.tendrilMat?.dispose();
		this.points = null;
		this.tendrils = null;
		this.pointMat = null;
		this.tendrilMat = null;
	}

	private makeSprite(): CanvasTexture {
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = 64;
		const ctx = canvas.getContext("2d")!;
		const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
		g.addColorStop(0, "rgba(255,255,255,1)");
		g.addColorStop(0.4, "rgba(255,255,255,0.5)");
		g.addColorStop(1, "rgba(255,255,255,0)");
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, 64, 64);
		return new CanvasTexture(canvas);
	}
}
