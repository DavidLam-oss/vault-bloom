# Vault Bloom

Render your Obsidian vault as a living neural network dashboard: an orb of
glowing module hubs, note nodes and luminous connections between them.

> Status: Phase 1 (MVP) shipped, Phase 2 (visual upgrade) in progress.

## Features

**Data layer** — straight from Obsidian's `metadataCache`, zero file parsing:

- resolved/unresolved links, ghost nodes for dead links, degree weighting
- module rule engine: group notes into hubs by path prefix / tag / frontmatter
  rule (first match wins)
- node position cache: existing nodes never jump when a note is edited
- incremental refresh on `resolved` / `changed` / `delete` / `rename`

**Rendering** — three.js, bare (no `3d-force-graph` wrapper):

- GPU-instanced glowing nodes, per-vertex-coloured edges
- jellyfish hubs: procedural bell, swim pulse, rim filaments
- particles streaming along every edge, plus hub→member tendrils
- fixed dark canvas, independent of the Obsidian theme (see Notes below)
- honours `prefers-reduced-motion`

**Interaction**

- orbit navigation: left-drag rotates, Cmd/Ctrl or right-drag pans, scroll zooms
  to the cursor
- hover highlights a node and its neighbours, and speeds up its connections
- click a hub (or a legend chip) to drill into a module, Esc to come back
- click a note to fly to it; the camera then slowly orbits its neighbourhood
- double-click a note to open it; the focus card shows backlinks, tags, snippet

## Development

```bash
npm install
npm run dev      # watch mode
npm run build    # typecheck + production bundle
npm run deploy   # copy main.js / manifest.json / styles.css into your vault
npm run start    # build + deploy
npm run smoke    # headless layout + motion assertions
npm run preview  # bundle the browser preview harness (see below)
```

Set `VAULT_BLOOM_TARGET` to override the deploy target, which defaults to:

```
~/Documents/Obsidian/MyVault/.obsidian/plugins/vault-bloom
```

After deploying, reload the plugin in Obsidian (or use the Hot-Reload plugin)
and open the dashboard from the ribbon icon or the command palette.

## Browser preview harness

Visual work does not need an Obsidian reload. `npm run preview` bundles
`scripts/preview/harness.ts` - the real dashboard chrome plus the real
`ThreeRenderer` running against a synthetic vault - into
`scripts/preview/.out/index.html`, which opens directly from the filesystem:

```
scripts/preview/.out/index.html?theme=light&focus=diary&notes=1800&links=1500&settle=1
```

The page fakes an Obsidian window: the top strip wears the emulated theme, the
view below it does not. `theme=light` is therefore the regression fixture for
the fixed dark canvas, not a light mode.

| Param | Effect |
|---|---|
| `theme=dark\|light` | emulate an Obsidian theme; only the fake chrome strip follows it |
| `focus=<moduleId>` | drill into a module after the layout settles |
| `notes` / `links` / `ghosts` / `seed` | resize the synthetic fixture |
| `details=1` | expand the debug drawer |
| `card=1` | inject a static focus card (CSS fixture) |
| `settle=1` | converge the layout synchronously, for byte-comparable screenshots |
| `motion=reduce` | emulate `prefers-reduced-motion: reduce` |
| `orphans=1` / `ghosts-toggle=0` | flip the graph toggles |

For a headless screenshot (software WebGL via chrome-headless-shell):

```bash
node scripts/preview/cdp.mjs \
  "file://$PWD/scripts/preview/.out/index.html?theme=light&settle=1" shot /tmp/vb.png 4000
```

`REDUCED=1` emulates `prefers-reduced-motion: reduce`, `WIDTH`/`HEIGHT` set the
viewport, `CLIP="x,y,w,h"` captures a single rectangle. The synthetic fixture
uses a seeded PRNG, so the same `seed` always produces the same layout and two
screenshots remain comparable.

## Notes

**The canvas is always dark, on purpose.** The view is a scene of glowing dots,
jellyfish and travelling light, all additive-blended - on a light surface the
glow saturates to white, the bells turn into grey blobs and the node colours
lose their contrast. So neither the canvas nor the chrome floating above it
follows the Obsidian theme; both read the `--nv-*` studio tokens in
`styles.css`. Obsidian's chrome around the view (tab header, sidebars) still
follows the theme. Rationale in `src/render/palette.ts`.

To check it still holds, compare the two themes region by region:

```bash
for t in dark light; do
  CLIP="12,51,1416,820" node scripts/preview/cdp.mjs \
    "file://$PWD/scripts/preview/.out/index.html?theme=$t&settle=1&motion=reduce" \
    shot /tmp/vb-$t.png 6000
done
shasum /tmp/vb-dark.png /tmp/vb-light.png   # must match
```

## License

MIT
