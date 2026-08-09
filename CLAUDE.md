# CLAUDE.md

Guidance for Claude Code when working in this repository.

## This repo is public

`DogTimeline` is (or will be) a public GitHub repo
(`github.com/EfficiencyJunky/DogTimeline`). It holds only the runtime site:
`index.html`, `static/`, `data/`.

**Never write or copy anything into this repo that references:**
- the private repo this site is built from, or that repo's name
- any local absolute file path (e.g. `/Users/...`)
- the site owner's personal folder structure or other private-repo layout details
- any other personal or sensitive information about the site owner

This applies to file contents, commit messages, and code comments alike.
Generic external citations (e.g. AKC/FCI breed-standard source URLs already
embedded in the breed data) are fine — they're already public and are the
whole point of the content. What's not fine is anything that reveals how the
private development setup behind this site is organized.

If a change to this repo would require referencing where the site is built
or how it's regenerated, ask first rather than including that reference —
there may be a way to phrase it generically, or it may belong only on the
private side.
