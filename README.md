# Neural Vault

Render your Obsidian vault as a living neural network dashboard: an orb, glowing
module hubs and luminous connections between your notes.

> Status: Phase 1 (MVP) in development. See [docs/PLAN.md](docs/PLAN.md) for the full three-phase plan.

## Development

```bash
npm install
npm run dev      # watch mode
npm run build    # typecheck + production bundle
npm run deploy   # copy main.js / manifest.json / styles.css into your vault
npm run start    # build + deploy
```

Set `NEURAL_VAULT_TARGET` to override the deploy target, which defaults to:

```
~/Documents/Obsidian/MyVault/.obsidian/plugins/neural-vault
```

After deploying, reload the plugin in Obsidian (or use the Hot-Reload plugin)
and open the dashboard from the ribbon icon or the command palette.

## License

MIT
