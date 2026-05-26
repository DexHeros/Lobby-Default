# DexHero Lobby — Default

The canonical default lobby for the DexHero platform.

Every V3Labs wallet that connects GitHub and edits their lobby gets a
personal fork of this repository. The platform runtime-fetches the
fork's files from `raw.githubusercontent.com` and serves them at
`https://v3labs.onrender.com/lobby/<wallet>/*`. Brand anchors in
`index.html` are verified on every fetch.

## Forking

You don't fork manually. The first time you ask your DexHero brain to
change something in your lobby, the platform forks this repo into your
GitHub account under the name `Lobby` (via the `repo` OAuth scope you
granted at signup), opens a preview branch for the brain's commits,
and serves that preview to you for review.

You merge the preview branch when you're happy with the change.

## Slot taxonomy

Brain edits land as commits on your fork. The platform classifies each
commit by file path to drive the Genetics page visualization:

| Slot     | Color  | Paths                                                   |
|----------|--------|---------------------------------------------------------|
| body     | cyan   | `styles/`, `pages/`, `index.html`, `app/ui/`, `components/` |
| brain    | violet | `app/services/llm-*`, `app/services/brain-*`            |
| voice    | green  | `app/services/voice-*`, `app/services/tts-*`            |
| movement | amber  | `app/services/motion-*`, `app/services/movement-*`      |

The UI vs UX strand is content-type derived:

- `*.css`, `*.html`, JSON config under `app/services/` → UI strand (top)
- `*.js` under `app/`, `js/`, `components/` → UX strand (bottom)

## Adopting community changes

When you hover a peg on the Genetics page authored by another wallet,
clicking "Adopt" replays that commit's file changes onto a new branch
of your fork (`adopt/<source-wallet>-<sha>`). You review, then merge.

When a commit's adoption count crosses 500 across all wallets, the
platform opens a Pull Request against this default repo. Once merged
here by maintainers and re-tagged, the change becomes the default for
every wallet that hasn't yet forked.

## License

GPL-3.0. See `LICENSE`. Third-party license notices in
`THIRD_PARTY_LICENSES.txt`.

## Don't remove

The three brand anchors in `index.html` are load-bearing — the
platform runtime falls back to this canonical default if they're
missing from a served fork:

```html
<meta name="dexhero:fork-of" content="DexHeros/Lobby-Default">
<link rel="canonical" href="https://v3labs.onrender.com/">
<div data-dexhero-anchor hidden data-version="lobby-default-v0.1.0"></div>
```
