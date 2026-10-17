# Project notes

Things to decide or do later. Dated; delete lines once done.

## Distribution (2026-10-09, to review)

The repo is a marketplace already (`.claude-plugin/marketplace.json`). Install from a terminal, two lines, no clone:

```bash
claude plugin marketplace add dbrownjave/claude-token-saver
claude plugin install token-saver@token-saver
```

`install.sh` is only for the Python modules and the settings preflight. `/plugin install` does not run inside the desktop app's Code tab; install once from a terminal at user scope and the desktop picks it up.

- [x] Put the two-line install above the git-clone line in README and `site/index.html`.
- [ ] Submit to the community directory: clau.de/plugin-directory-submission (paid claude.ai plan needed; `anthropics/claude-plugins-community` is a read-only mirror, PRs auto-close). Run `claude plugin validate ./plugins/token-saver --strict` first (passes as of 0.3.36; the marketplace manifest passes `--strict` too since it got a description). Listing text comes from `plugin.json` + README. The name `token-saver` is now fixed: renaming breaks installs.
- [ ] Official marketplace (`anthropics/claude-plugins-official`) is curated by Anthropic via partner contacts, not a form. Path there is traction on the community listing.
- [x] GitHub Pages for `site/`: Pages serves `/` or `/docs` only, so add `.github/workflows/pages.yml` that publishes `site/` on push to `main`, then enable Pages in repo settings. Workflow added 2026-10-16; Settings → Pages → Source: GitHub Actions is still the owner's step.
- [ ] Real screenshot of the pane (terminal + desktop) in README and site, replacing the mock. Terminal dark and light done 2026-10-16 (`site/img/`); desktop dark and light still to capture.

## Money (to review)

No payment layer in marketplaces, and a plugin is source on every user's disk, so a licence check inside it is theatre. The working pattern is free plugin, paid backend (CoinPaprika: MIT plugin, Pro tier on the API). Honest options for this project, if ever:
- Hosted team dashboard: cross-machine savings, fleet-wide skill loadouts.
- Paid rollout support for companies.
The plugin stays free.

Sources: code.claude.com/docs/en/plugins/publish · code.claude.com/docs/en/plugin-marketplaces · github.com/anthropics/claude-plugins-official · github.com/anthropics/claude-plugins-community · agent37.com/blog/monetize-claude-code-skills
