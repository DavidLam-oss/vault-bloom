// Smooth camera flight between two poses (position + orbit target).
// Extracted from ThreeRenderer to keep the renderer file small; also easy
// to unit-test and reuse when Phase 2 adds more cinematic moves.

import { PerspectiveCamera } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Vector3 } from "three";

interface FlightState {
	fromPos: Vector3;
	toPos: Vector3;
	fromTgt: Vector3;
	toTgt: Vector3;
	started: number;
	durationMs: number;
}

export class CameraFly {
	private flight: FlightState | null = null;

	constructor(
		private camera: PerspectiveCamera,
		private controls: OrbitControls
	) {}

	/** True while a flight is running (the render loop must skip controls.update). */
	get active(): boolean {
		return this.flight !== null;
	}

	flyTo(target: Vector3, position: Vector3, durationMs = 650): void {
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

	/** Advance one frame; call every frame while active. */
	tick(): void {
		const f = this.flight;
		if (!f) return;
		const raw = (performance.now() - f.started) / f.durationMs;
		if (raw >= 1) {
			this.camera.position.copy(f.toPos);
			this.controls.target.copy(f.toTgt);
			this.finish();
			return;
		}
		const s = raw * raw * (3 - 2 * raw); // smoothstep ease-in-out
		this.camera.position.lerpVectors(f.fromPos, f.toPos, s);
		this.controls.target.lerpVectors(f.fromTgt, f.toTgt, s);
		this.camera.lookAt(this.controls.target);
	}

	/** User grabbed the canvas mid-flight: stop where we are, hand back control. */
	cancel(): void {
		if (this.flight) this.finish();
	}

	private finish(): void {
		this.flight = null;
		this.controls.enabled = true;
		this.controls.update();
	}
}
