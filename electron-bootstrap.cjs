try {
  const electron = require("electron");
  const app = electron?.app;

  if (process.env.CODEX_FORCE_PACKAGED === "1" && app) {
    const descriptor = Object.getOwnPropertyDescriptor(app, "isPackaged");

    if (!descriptor || descriptor.configurable) {
      Object.defineProperty(app, "isPackaged", {
        configurable: true,
        enumerable: true,
        get() {
          return true;
        },
      });
    }
  }

  if (app && !app.__ccloneDiagnosticsInstalled) {
    Object.defineProperty(app, "__ccloneDiagnosticsInstalled", {
      value: true,
      configurable: true,
    });

    app.on("web-contents-created", (_event, contents) => {
      contents.on("console-message", (_e, level, message, line, sourceId) => {
        console.error(
          `[cclone][renderer-console] level=${level} line=${line} source=${sourceId} message=${message}`,
        );
      });

      contents.on(
        "did-fail-load",
        (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
          console.error(
            `[cclone][did-fail-load] code=${errorCode} mainFrame=${isMainFrame} url=${validatedURL} desc=${errorDescription}`,
          );
        },
      );

      contents.on("render-process-gone", (_e, details) => {
        console.error(
          `[cclone][render-process-gone] reason=${details.reason} exitCode=${details.exitCode}`,
        );
      });

      contents.on("unresponsive", () => {
        console.error("[cclone][renderer-unresponsive]");
      });
    });
  }
} catch {
  // Allow Electron to continue even if diagnostics bootstrap fails.
}
