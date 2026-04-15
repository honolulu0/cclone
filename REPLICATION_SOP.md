# cclone Replication SOP

This SOP defines how to refresh `cclone/` from the root package payload without copying `desktop-clone/`.

## Source Of Truth

Always treat the workspace root package payload as canonical:

- `app/resources/app.asar`
- `app/resources/app.asar.unpacked`
- `app/resources/native`
- `app/resources/codex.exe`
- `app/resources/rg.exe`

Do not use `desktop-clone/` as an intermediate source.

## Rebuild cclone

```powershell
cd D:\niuma\OpenAI.Codex_26.325.3894.0_x64
node scripts/extract-codex-desktop.mjs --target cclone
cd cclone
npm install
npm start
```

If your environment requires the local proxy, launch from a shell that already sets:

```cmd
set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897
set NO_PROXY=localhost,127.0.0.1
```

Or use:

```cmd
scripts\start-cclone-with-proxy.cmd
```

## Required Behavior

`cclone/` must:

- launch from its own directory
- use local bundled assets instead of `localhost:5175`
- use the local extracted CLI binary
- preserve unpacked modules and native files

## Runtime Layer

`cclone/start.cjs` is responsible for:

- forcing packaged production mode
- locating the real main bundle dynamically
- patching the dev-server branch out unless `ELECTRON_FORCE_DEV_SERVER=1`
- injecting `app/api-bridge.cjs`
- forwarding proxy variables when they are already present

`cclone/app/api-bridge.cjs` is now a host shim loader:

- default: loads `app/host-shim/http-host-shim.cjs`
- optional: loads an external module from `CCLONE_HOST_SHIM_ENTRY`
- contract: the loaded module must export `startExternalApiServer(...)`

`cclone/electron-bootstrap.cjs` is responsible for:

- forcing `app.isPackaged === true` at runtime
- surfacing renderer diagnostics

## Validation

After each refresh:

1. Confirm `cclone/app/node_modules/better-sqlite3/lib/index.js` is non-empty.
2. Start the app from `cclone/`.
3. Confirm logs do not show `localhost:5175` or `ERR_CONNECTION_REFUSED`.
4. Confirm the window loads instead of staying blank.

## Design Constraint

`cclone/` is the clean branch for alternate development. Keep it minimal and avoid pulling feature layers from `desktop-clone/` unless they are intentionally reimplemented here.
