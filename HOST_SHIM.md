# cclone Host Shim

`cclone` keeps a host shim because it must stay attached to the in-process runtime:

- the active `appServerConnection`
- thread and turn lifecycle
- internal notifications

That host shim should remain minimal.

## Current entrypoint

- loader: [app/api-bridge.cjs](D:/niuma/OpenAI.Codex_26.325.3894.0_x64/cclone/app/api-bridge.cjs)
- default implementation: [app/host-shim/http-host-shim.cjs](D:/niuma/OpenAI.Codex_26.325.3894.0_x64/cclone/app/host-shim/http-host-shim.cjs)

## External ownership path

If `CCLONE_HOST_SHIM_ENTRY` is set, the loader resolves and requires that module instead.

The external module must export:

```js
module.exports = {
  startExternalApiServer({ appServerConnection, windowContext }) {
    // ...
  },
};
```

## Boundary rule

Keep in the host shim:

- model list
- thread read/start
- turn start/stream/interrupt
- thread rename
- runtime event subscription

Keep out of the host shim:

- prompt CRUD
- send profiles
- template rendering
- business UI
- storage

Those belong in `cclone-control/`.
