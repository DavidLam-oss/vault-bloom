// d3-force-3d ships no type declarations. This shim covers the subset of the
// API Neural Vault uses (3D simulation with link / charge / directional
// forces). Typed loosely on purpose: forces are consumed fluently.

declare module "d3-force-3d" {
	export interface SimulationNodeDatum {
		index?: number;
		x?: number;
		y?: number;
		z?: number;
		vx?: number;
		vy?: number;
		vz?: number;
		fx?: number | null;
		fy?: number | null;
		fz?: number | null;
	}

	export interface SimulationLinkDatum<N extends SimulationNodeDatum> {
		index?: number;
		source: N | string | number;
		target: N | string | number;
	}

	export interface Simulation<N extends SimulationNodeDatum, L extends SimulationLinkDatum<N>> {
		numDimensions(dimensions: number): this;
		nodes(nodes: N[]): this;
		force(name: string, force: unknown): this;
		alpha(value: number): this;
		alpha(): number;
		alphaMin(value: number): this;
		alphaDecay(value: number): this;
		velocityDecay(value: number): this;
		stop(): this;
		tick(): this;
	}

	export interface ForceLink<N extends SimulationNodeDatum, L extends SimulationLinkDatum<N>> {
		id(accessor: (node: N, index: number) => string): this;
		distance(value: number | ((link: L, index: number) => number)): this;
		strength(value: number | ((link: L, index: number) => number)): this;
	}

	export interface ForceManyBody {
		strength(value: number | ((node: any, index: number) => number)): this;
		distanceMax(value: number): this;
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	export interface ForceDirectional {
		x(value: number | ((node: any, index: number) => number)): this;
		y(value: number | ((node: any, index: number) => number)): this;
		z(value: number | ((node: any, index: number) => number)): this;
		strength(value: number | ((node: any, index: number) => number)): this;
	}

	export function forceSimulation<N extends SimulationNodeDatum, L extends SimulationLinkDatum<N>>(
		nodes?: N[]
	): Simulation<N, L>;

	export function forceLink<N extends SimulationNodeDatum, L extends SimulationLinkDatum<N>>(
		links?: L[]
	): ForceLink<N, L>;

	export function forceManyBody(): ForceManyBody;

	export function forceX(): ForceDirectional;
	export function forceY(): ForceDirectional;
	export function forceZ(): ForceDirectional;
}
