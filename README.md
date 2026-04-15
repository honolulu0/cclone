# cclone

`cclone/` is a clean Codex desktop replica generated directly from the root package payload.

It is intentionally separate from `desktop-clone/`:

- `desktop-clone/` can continue carrying experimental or product-specific customizations
- `cclone/` is the clean baseline for a different development track
- extraction starts from `app/resources/*`, not from another clone directory

## Build

```powershell
cd D:\niuma\OpenAI.Codex_26.325.3894.0_x64
node scripts/extract-codex-desktop.mjs --target cclone
cd cclone
npm install
npm start
```

## Proxy-aware Launch

If startup should always inherit the local proxy, use:

```cmd
scripts\start-cclone-with-proxy.cmd
```

That wrapper sets:

```cmd
set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897
set NO_PROXY=localhost,127.0.0.1
```

`NO_PROXY` must keep `localhost,127.0.0.1` so host-shim traffic stays direct.

## What cclone keeps

- local bundled renderer assets
- local `codex.exe` / `codex`
- merged `app.asar.unpacked` files
- native helper binaries
- dev-server bypass patch for the main bundle
- a lightweight host shim entrypoint for runtime control

## Host Shim Boundary

`cclone/` now treats [app/api-bridge.cjs](D:/niuma/OpenAI.Codex_26.325.3894.0_x64/cclone/app/api-bridge.cjs) as a loader, not as a place for growing product logic.

- default behavior loads the local HTTP shim from `app/host-shim/http-host-shim.cjs`
- optional behavior loads an external shim module from `CCLONE_HOST_SHIM_ENTRY`
- the shim still runs inside the `cclone` process
- prompts, profiles, and orchestration should live in the independent `cclone-control/` project

See [HOST_SHIM.md](D:/niuma/OpenAI.Codex_26.325.3894.0_x64/cclone/HOST_SHIM.md).

## What cclone does not inherit

- prompt tooling UI extensions
- custom send profile management
- hotkey customization layer
- other `desktop-clone/`-specific product experiments
