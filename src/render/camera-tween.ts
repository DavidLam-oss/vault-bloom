// Smooth camera flight between two poses (position + orbit target), plus a
// gentle post-arrival orbit mode (galaxy-view beginFocusOrbit): after flying
// to a node the camera slowly circles it, drifting toward the side where its
// neighbors cluster. Any user input (grab / wheel) cancels the takeover.

import { PerspectiveCamera, Vector3 } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

interface FlightState {
	fromPos: Vector3;
	toPos: Vector3;
	fromTgt: Vector3;
	toTgt: Vector3;
	started: number;
	durationMs: number;
}

interface OrbitState {
	center: Vector3;
	/** signed angular velocity around world up (rad/s) */
	vel: number;
}

const ORBIT_VEL = 0.22; // full circle ~28s
const UP = new Vector3(0, 1, 0);

export class CameraFly {
	private flight: FlightState | null = null;
	private orbit: OrbitState | null = null;
	private pendingOrbit: { center: Vector3; bias: Vector3 | null } | null = null;

	constructor(
		private camera: PerspectiveCamera,
		private controls: OrbitControls
	) {}

	/** True while a flight is running (the render loop must skip controls.update). */
	get active(): boolean {
		return this.flight !== null;
	}

	/** True while the camera is taken over by flight OR orbit. */
	get busy(): boolean {
		return this.flight !== null || this.orbit !== null;
	}

	flyTo(target: Vector3, position: Vector3, durationMs = 650): void {
		this.orbit = null;
		this.pendingOrbit = null;
		this.flight = {
			fromPos: this.camera.position.clone(),
			toPos: position.clone(),
			fromTgt: this.controls.target.clone(),
			toTgt: target.clone(),
			started: performance.now(),
			durationMs: Math.max(1, durationMs),
		};
		// Damping would fight the per-frame lerp, so park the controls.
		this.controls.enabled = false;
	}

	/**
	 * Fly to frame a single node (galaxy-view FLY_TO formula): keep the
	 * current view direction, park the camera at radius*12 (clamped 40-140)
	 * from the node. `bias` (a direction from the node toward its neighbor
	 * cluster) makes the post-arrival orbit sweep across the dense side.
	 */
	flyToNode(nodePos: Vector3, nodeRadius: number, bias: Vector3 | null = null, durationMs = 700): void {
		const dist = Math.min(140, Math.max(40, nodeRadius * 12));
		const dir = this.camera.position.clone().sub(this.controls.target);
		if (dir.lengthSq() < 1e-6) dir.set(0.62, 0.46, 0.62);
		dir.normalize();
		this.flyTo(nodePos, nodePos.clone().add(dir.multiplyScalar(dist)), durationMs);
		this.pendingOrbit = { center: nodePos.clone(), bias };
	}

	/** Advance one frame; call every frame while busy. dt drives the orbit. */
	tick(dt = 1 / 60): void {
		const f = this.flight;
		if (f) {
			const raw = (performance.now() - f.started) / f.durationMs;
			if (raw >= 1) {
				this.camera.position.copy(f.toPos);
				this.controls.target.copy(f.toTgt);
				this.arrive();
				return;
			}
			const s = raw * raw * (3 - 2 * raw); // smoothstep ease-in-out
			this.camera.position.lerpVectors(f.fromPos, f.toPos, s);
			this.controls.target.lerpVectors(f.fromTgt, f.toTgt, s);
			this.camera.lookAt(this.controls.target);
			return;
		}
		if (this.orbit) this.tickOrbit(dt);
	}

	/** User grabbed the canvas or scrolled: hand the camera back immediately. */
	cancel(): void {
		this.pendingOrbit = null;
		this.orbit = null;
		this.flight = null;
		this.controls.enabled = true;
		this.controls.update();
	}

	private arrive(): void {
		this.flight = null;
		const p = this.pendingOrbit;
		this.pendingOrbit = null;
		if (p) this.beginOrbit(p.center, p.bias);
		else {
			this.controls.enabled = true;
			this.controls.update();
		}
	}

	private beginOrbit(center: Vector3, bias: Vector3 | null): void {
		const offset = this.camera.position.clone().sub(center);
		if (offset.lengthSq() < 1e-6) {
			this.controls.enabled = true;
			return;
		}
		// Drift direction: rotate toward the bias azimuth when given.
		let vel = ORBIT_VEL;
		if (bias) {
			const b = bias.clone();
			b.y = 0;
			const o = offset.clone();
			o.y = 0;
			// sin of the (signed) angle from offset azimuth to bias azimuth
			// around +Y; sign tells which way to spin.
			const sinDelta = b.x * o.z - b.z * o.x;
			if (Math.abs(sinDelta) > 1e-9) vel = sinDelta > 0 ? ORBIT_VEL : -ORBIT_VEL;
		}
		this.orbit = { center: center.clone(), vel };
		this.controls.enabled = false;
	}

	private tickOrbit(dt: number): void {
		const o = this.orbit!;
		const offset = this.camera.position.clone().sub(o.center);
		offset.applyAxisAngle(UP, o.vel * dt);
		this.camera.position.copy(o.center).add(offset);
		this.camera.lookAt(o.center);
		this.controls.target.copy(o.center);
	}
}
