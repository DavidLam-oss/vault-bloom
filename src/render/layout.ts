// Force-directed layout (d3-force-3d, CPU simulation, bare - no wrapper).
//
// Two hard requirements from the plan:
// 1. Position cache: nodes already laid out keep their coordinates; only NEW
//    nodes enter the simulation (pinned in place, existing ones are frozen).
//    This is what keeps the graph from jumping on every note edit.
// 2. Clustering: members are pulled toward their module "jellyfish hub",
//    with hub gravity adapted to module size (big modules spread wider).

import {
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	forceZ,
	type Simulation,
	type SimulationLinkDatum,
	type SimulationNodeDatum,
} from "d3-force-3d";
import type { GraphNode, NeuralGraph } from "../data/types";

interface SimNode extends SimulationNodeDatum {
	id: string;
	moduleId: string;
	x: number;
	y: number;
	z: number;
	fx: number | null;
	fy: number | null;
	fz: number | null;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
	kind: string;
}

interface Hub {
	x: number;
	y: number;
	z: number;
}

const ALPHA_STOP = 0.005;
/** alpha used when only a few new nodes joined */
const REHEAT_ALPHA = 0.5;
export class ForceLayout {
	/** id -> last settled position, survives rebuilds (the "no jump" cache) */
	private cache = new Map<string, { x: number; y: number; z: number }>();
	private sim: Simulation<SimNode, SimLink> | null = null;
	/** visible nodes, aligned 1:1 with whatever order the renderer uses */
	nodes: SimNode[] = [];
	/** visible edges as [sourceIndex, targetIndex, kind] */
	edges: Array<{ source: number; target: number; kind: string }> = [];

	private lastHubRadius = 0;
	private lastMaxSize = 1;
	/** hub positions of the most recent update(), exposed for hub rendering */
	private lastHubs = new Map<string, Hub>();
	/**
	 * True once the simulation has cooled down and been harvested. Without
	 * this the render loop would keep calling sim.tick() + harvest() forever
	 * (alpha decays towards 0 but never reaches it), burning a full O(nodes)
	 * cache write every frame on a graph that is not moving.
	 */
	private settled = true;

	/**
	 * (Re)build the simulation for the current visible subgraph.
	 * Reuses cached positions for known nodes (pinned), spawns new nodes
	 * near their module hub, and reheats the simulation.
	 */
	update(graph: NeuralGraph, visibleIds: Set<string>): void {
		this.sim?.stop();
		this.sim = null;
		this.settled = false;

		const byId = new Map<string, GraphNode>();
		for (const node of graph.nodes) byId.set(node.id, node);

		// Module hubs on a circle; radius grows with the number of active
		// modules, gravity per node shrinks with module size.
		const sizes = new Map<string, number>();
		for (const id of visibleIds) {
			const node = byId.get(id);
			if (!node || node.kind !== "note") continue;
			sizes.set(node.moduleId, (sizes.get(node.moduleId) ?? 0) + 1);
		}
		const maxSize = Math.max(1, ...sizes.values());
		this.lastMaxSize = maxSize;
		const hubs = this.computeHubs([...sizes.keys()], maxSize);
		this.lastHubs = hubs;

		// Nodes.
		const previousIds = new Set(this.nodes.map((n) => n.id));
		this.nodes = [];
		for (const nodeId of visibleIds) {
			const node = byId.get(nodeId);
			if (!node) continue;
			const cached = this.cache.get(nodeId);
			if (cached) {
				this.nodes.push({
					id: nodeId,
					moduleId: node.moduleId,
					x: cached.x, y: cached.y, z: cached.z,
					fx: cached.x, fy: cached.y, fz: cached.z,
					vx: 0, vy: 0, vz: 0,
				});
				continue;
			}
			const hub = hubs.get(node.moduleId) ?? { x: 0, y: 0, z: 0 };
			const size = sizes.get(node.moduleId) ?? 1;
			const spread = 14 + 5 * Math.sqrt(size);
			this.nodes.push({
				id: nodeId,
				moduleId: node.moduleId,
				x: hub.x + this.gauss() * spread,
				y: hub.y + this.gauss() * spread * 0.5,
				z: hub.z + this.gauss() * spread,
				fx: null, fy: null, fz: null,
				vx: 0, vy: 0, vz: 0,
			});
		}

		// Edges between visible nodes (indices refer to this.nodes).
		const indexOf = new Map(this.nodes.map((n, i) => [n.id, i]));
		this.edges = [];
		for (const edge of graph.edges) {
			const a = indexOf.get(edge.source);
			const b = indexOf.get(edge.target);
			if (a === undefined || b === undefined) continue;
			this.edges.push({ source: a, target: b, kind: edge.kind });
		}

		// Simulation. All forces read the hub off each node; pinned nodes
		// ignore forces entirely (d3 keeps them at fx/fy/fz).
		const hubOf = (n: SimNode): Hub =>
			hubs.get(n.moduleId) ?? { x: 0, y: 0, z: 0 };
		const hubStrength = (n: SimNode): number => {
			const size = sizes.get(n.moduleId) ?? 1;
			return Math.max(0.02, 0.6 / Math.sqrt(size));
		};

		// Link endpoints must be node IDs (strings) because the force is
		// configured with .id(n => n.id); passing numeric indices would make
		// d3 look them up as IDs and throw "node not found: <index>".
		const simLinks: SimLink[] = this.edges.map((e) => ({
			source: this.nodes[e.source].id,
			target: this.nodes[e.target].id,
			kind: e.kind,
		}));

		this.sim = forceSimulation<SimNode, SimLink>(this.nodes)
			.numDimensions(3)
			.force(
				"link",
				forceLink<SimNode, SimLink>(simLinks)
					.id((n) => n.id)
					.distance((l) => (l.kind === "ghost" ? 40 : 28))
					.strength(0.35)
			)
			.force("charge", forceManyBody().strength(-60).distanceMax(420))
			.force("hub.x", forceX().x((n) => hubOf(n).x).strength(hubStrength))
			.force("hub.y", forceY().y((n) => hubOf(n).y).strength((n) => hubStrength(n) * 0.6))
			.force("hub.z", forceZ().z((n) => hubOf(n).z).strength(hubStrength))
			.velocityDecay(0.5)
			.alphaDecay(0.03)
			.alphaMin(ALPHA_STOP);

		const coldStart = this.nodes.length > 0 && previousIds.size === 0;
		const sim = this.sim;
		if (sim) {
			sim.alpha(coldStart ? 1 : REHEAT_ALPHA);
			sim.stop();
		}
	}

	/** Run the simulation to convergence synchronously (cold start only). */
	prewarm(maxTicks = 400): void {
		if (!this.sim) return;
		let ticks = 0;
		while (this.sim.alpha() >= ALPHA_STOP && ticks < maxTicks) {
			this.sim.tick();
			ticks++;
		}
		this.harvest();
		this.settled = true;
	}

	/**
	 * Advance one tick; returns true while the layout is still hot. Once the
	 * simulation has cooled this is a cheap no-op so the render loop can call
	 * it unconditionally.
	 */
	tick(): boolean {
		if (!this.sim || this.settled) return false;
		this.sim.tick();
		if (this.sim.alpha() < ALPHA_STOP) {
			this.harvest();
			this.settled = true;
			this.sim.stop();
			return false;
		}
		return true;
	}

	/** True while the layout has not been built or has already cooled down. */
	isCold(): boolean {
		return this.sim === null || this.settled;
	}

	/** Store settled positions into the cache and unpin everything. */
	private harvest(): void {
		for (const n of this.nodes) {
			this.cache.set(n.id, { x: n.x, y: n.y, z: n.z });
			n.fx = n.fy = n.fz = null;
		}
	}

	/**
	 * Drop cache entries for nodes that vanished, so deleting a note and
	 * recreating it later still gets a fresh spot.
	 */
	pruneCache(visibleIds: Set<string>): void {
		if (this.cache.size <= visibleIds.size) return;
		for (const id of [...this.cache.keys()]) {
			if (!visibleIds.has(id)) this.cache.delete(id);
		}
	}

	/**
	 * Camera-fit helper for the animated cold start: the graph grows over the
	 * first seconds, so the camera must frame the EXPECTED extent, not the
	 * current one.
	 */
	estimateRadius(): number {
		return this.lastHubRadius + 4 * Math.sqrt(this.lastMaxSize) + 80;
	}

	/** Hub (cluster center) positions from the most recent update(). */
	getHubs(): Map<string, Hub> {
		return this.lastHubs;
	}

	private computeHubs(moduleIds: string[], maxSize: number): Map<string, Hub> {
		const hubs = new Map<string, Hub>();
		const count = moduleIds.length;
		if (count === 0) return hubs;
		// Spread hubs so natural charge clouds (radius ~ sqrt(size)) don't
		// merge into one blob; grows with the largest module's mass.
		const radius = count === 1 ? 0 : 12 * Math.sqrt(count * Math.max(1, maxSize));
		this.lastHubRadius = radius;
		moduleIds.forEach((id, i) => {
			const angle = (i / count) * Math.PI * 2;
			hubs.set(id, {
				x: Math.cos(angle) * radius,
				y: 0,
				z: Math.sin(angle) * radius,
			});
		});
		return hubs;
	}

	private gauss(): number {
		return (Math.random() + Math.random() + Math.random() - 1.5) * 0.8;
	}
}
