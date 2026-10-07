// Canvas palette - permanently dark.
//
// The dashboard is a scene of glowing note-dots, jellyfish hubs and travelling
// light. Every one of those effects is built on additive blending, which needs
// a dark surface: on a light one the glow saturates straight to white and
// vanishes, the bell reads as a flat grey blob, and the dimmed/edge colours
// lose the contrast the whole picture depends on.
//
// So the canvas does NOT follow the host theme. It is a fixed dark studio, and
// the overlay chrome (toolbar, legend, hover read-out, focus card) is pinned to
// the same dark tokens in styles.css - otherwise a white toolbar would float on
// a black picture. The chrome AROUND this view (tab header, sidebars) still
// follows the user's theme; only this view's own surface is dark. The trade is
// deliberate: the view is a picture, and a picture gets a frame that suits it.
//
// That is also why this module no longer reads Obsidian's CSS variables: there
// is nothing theme-dependent left to resolve.

import { AdditiveBlending, type Blending, Color } from "three";

export interface Palette {
	/** canvas clear color / fog color */
	background: number;
	/** resolved [[wikilink]] edge */
	link: Color;
	/** edge to an unresolved (ghost) note */
	ghostEdge: Color;
	/** ghost node */
	ghost: Color;
	/** hovered node */
	highlight: Color;
	/** neighbors of the hovered node */
	neighbor: Color;
	/** flowing particle on a resolved edge */
	linkFlow: Color;
	/** flowing particle on a ghost edge */
	ghostFlow: Color;
	/** glow blending for the flow layer */
	flowBlending: Blending;
	/** per-vertex edge opacity */
	edgeOpacity: number;
	/** jellyfish bell opacity in the overview */
	hubBaseOpacity: number;
	/** brightness floor of a flow particle along its edge */
	minBright: number;
	/** how far the LOD fade is allowed to dim the flow layer at overview range */
	flowMinOpacity: number;
}

/** The one and only canvas palette. Exported so headless tests (and the
 *  preview harness) can build render layers without a live renderer. */
export const PALETTE: Palette = {
	background: 0x0b0f17,
	link: new Color(0x39435c),
	ghostEdge: new Color(0x514583),
	ghost: new Color(0x8f83e0),
	highlight: new Color(0xffd47f),
	neighbor: new Color(0xd8e6ff),
	linkFlow: new Color(0x9db4e6),
	ghostFlow: new Color(0x8677c2),
	flowBlending: AdditiveBlending,
	edgeOpacity: 0.5,
	// A DoubleSide bell stacks the near and far shells, so the effective
	// opacity in the middle of the bell is roughly twice this. 0.3 keeps the
	// nodes behind a hub readable while the bell still reads as a volume.
	hubBaseOpacity: 0.3,
	minBright: 0.18,
	flowMinOpacity: 0.22,
};

/**
 * 0xRRGGBB -> "#rrggbb". Used to hand the canvas background to CSS (the
 * canvas wrapper is tinted before the first WebGL frame lands), so the
 * view surface and the renderer can never drift apart.
 */
export function cssHex(rgb: number): string {
	return `#${(rgb >>> 0).toString(16).padStart(6, "0")}`;
}
