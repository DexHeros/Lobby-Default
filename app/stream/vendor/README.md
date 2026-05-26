# app/stream/vendor/ — DexHero Player WASM decoder drop zone

This directory is the integration point for the **moonlight-web fork** (milestone M6). Until the fork lands, [../player.js](../player.js) imports `./dexhero-player.js` dynamically and falls back to diagnostic mode (canvas placeholder with live stats) when the import fails — so every other piece of the Play-panel pipeline is testable without this drop.

## Drop files

When the fork is built, place these two files here:

```
app/stream/vendor/
├── dexhero-player.js      # ES module exporting createDecoder()
├── dexhero-player.wasm    # WASM decoder binary
└── LICENSE.txt            # GPL-3.0 attribution (see FORK_INSTRUCTIONS.md §2.4)
```

## Required `createDecoder` shape

The factory must return an object with exactly these two methods:

```js
export async function createDecoder({ videoEl, codec }) {
    // videoEl: HTMLVideoElement — decoded frames render here via MediaSource
    // codec:   string[]         — preferred codecs, e.g. ['h264','av1']
    //
    // Returns: { feed(Uint8Array): void, destroy(): void }
}
```

`feed()` is invoked for every WebSocket frame received by the player — the underlying Moonlight/ENet wire format is internal to the decoder.

## Branding checklist when the fork ships

Per Part 8 of the approved plan:

- [ ] WASM binary renamed from `moonlight.wasm` → `dexhero-player.wasm`
- [ ] ES module renamed from `moonlight-web.js` → `dexhero-player.js`
- [ ] Any public JS class names prefixed `Moonlight*` → `DexHero*`
- [ ] Console log prefix `[moonlight]` → `[DexHero Player]`
- [ ] `LICENSE.txt` bundled here; the About dialog in the web app reads it

See [/Users/mojo/Desktop/V3Labs/FORK_INSTRUCTIONS.md](../../../FORK_INSTRUCTIONS.md) for the full fork + build procedure.
