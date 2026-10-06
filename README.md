# Vault Bloom

Render your Obsidian vault as a living neural network dashboard: an orb, glowing
module hubs and luminous connections between your notes.

> Status: Phase 1 (MVP) in development.

## Features (v0.1)

- Graph data straight from Obsidian's `metadataCache` (resolved/unresolved links,
  ghost nodes for dead links, zero file parsing)
- Module rule engine: group notes into module hubs by path prefix / frontmatter /
  tag rules (first match wins)
- three.js rendering: GPU-instanced glowing nodes, module hub clustering via
  d3-force-3d, node position cache (existing nodes never jump on updates)
- Orbit navigation: left-drag rotates, Cmd/Ctrl or right-drag pans, scroll zooms
- Hover highlights neighbors, click a note to jump into the editor

## Development

```bash
npm install
npm run dev      # watch mode
npm run build    # typecheck + production bundle
npm run deploy   # copy main.js / manifest.json / styles.css into your vault
npm run start    # build + deploy
npm run smoke    # headless layout assertions
```

Set `VAULT_BLOOM_TARGET` to override the deploy target, which defaults to:

```
~/Documents/Obsidian/MyVault/.obsidian/plugins/vault-bloom
```

After deploying, reload the plugin in Obsidian (or use the Hot-Reload plugin)
and open the dashboard from the ribbon icon or the command palette.

## License

MIT
