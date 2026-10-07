// Motion preference.
//
// The plan calls for respecting prefers-reduced-motion: the dashboard is a
// continuously animating scene (force layout, streaming particles, camera
// flights and a post-arrival orbit), which is exactly the kind of thing that
// makes some users motion-sick. The OS preference is honoured by default and
// can be overridden either way in the settings tab.

export type MotionSetting = "system" | "reduce" | "full";

export const MOTION_OPTIONS: Record<MotionSetting, string> = {
	system: "Follow system",
	reduce: "Always reduce",
	full: "Never reduce",
};

/** Does the OS ask for reduced motion? */
export function systemPrefersReducedMotion(): boolean {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
		return false;
	}
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Effective preference: an explicit setting wins, otherwise ask the OS. */
export function resolveReducedMotion(setting: MotionSetting): boolean {
	if (setting === "reduce") return true;
	if (setting === "full") return false;
	return systemPrefersReducedMotion();
}
