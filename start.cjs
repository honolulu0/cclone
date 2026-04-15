const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const rootDir = __dirname;
const appDir = path.join(rootDir, "app");
const buildDir = path.join(appDir, ".vite", "build");
const electronCli = require.resolve("electron/cli.js");
const electronBootstrap = path.join(rootDir, "electron-bootstrap.cjs");

function assertExists(filePath, description) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${description}: ${filePath}`);
  }

  return filePath;
}

function resolveCodexBinary() {
  const candidates = [
    path.join(rootDir, process.platform === "win32" ? "codex.exe" : "codex"),
    path.join(rootDir, "codex.exe"),
    path.join(rootDir, "codex"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Unable to locate the local Codex CLI binary.");
}

function resolveMainBundlePath() {
  assertExists(buildDir, "Vite build directory");
  const candidates = fs
    .readdirSync(buildDir)
    .filter((fileName) => /^main-.*\.js$/.test(fileName))
    .sort();

  if (candidates.length === 0) {
    throw new Error(`Unable to locate the main bundle under ${buildDir}`);
  }

  return path.join(buildDir, candidates[0]);
}

function applyRuntimePatch(filePath, from, to) {
  const text = fs.readFileSync(filePath, "utf8");

  if (text.includes(to)) {
    return false;
  }

  if (!text.includes(from)) {
    throw new Error(`Runtime patch target not found in ${filePath}`);
  }

  fs.writeFileSync(filePath, text.replace(from, to), "utf8");
  return true;
}

function ensureRuntimePatches() {
  const mainBundlePath = resolveMainBundlePath();

  applyRuntimePatch(
    mainBundlePath,
    "!n.app.isPackaged){let e=new URL(Kh());return u&&e.searchParams.set(`initialRoute`,u),e.searchParams.set(`hostId`,d),D.loadURL(e.toString()),D}",
    "!n.app.isPackaged&&process.env.ELECTRON_FORCE_DEV_SERVER===`1`){let e=new URL(Kh());return u&&e.searchParams.set(`initialRoute`,u),e.searchParams.set(`hostId`,d),D.loadURL(e.toString()),D}",
  );

  applyRuntimePatch(
    mainBundlePath,
    "let ne=P.getOrCreateContext(P.localHost),re=we({appServerConnectionRegistry:ne.appServerConnectionRegistry,gitManager:N.gitManager,globalState:j.globalState,appServerClient:ne.appServerClient,desktopNotificationManager:P.desktopNotificationManager,windowManager:M.windowManager});",
    "let ne=P.getOrCreateContext(P.localHost),__externalApiBridge=require(`../../api-bridge.cjs`),re=we({appServerConnectionRegistry:ne.appServerConnectionRegistry,gitManager:N.gitManager,globalState:j.globalState,appServerClient:ne.appServerClient,desktopNotificationManager:P.desktopNotificationManager,windowManager:M.windowManager});",
  );

  applyRuntimePatch(
    mainBundlePath,
    "ne.getMessageHandler().setAutomationSchedulerController(re),O.add(()=>{re.dispose()}),w(`local host context initialized`,k),",
    "ne.getMessageHandler().setAutomationSchedulerController(re);let __externalApiServer=__externalApiBridge.startExternalApiServer?__externalApiBridge.startExternalApiServer({appServerConnection:ne.appServerConnectionRegistry.getConnection(ne.hostId),windowContext:ne}):null;__externalApiServer&&O.add(()=>{__externalApiServer.dispose()}),O.add(()=>{re.dispose()}),w(`local host context initialized`,k),",
  );
}

function buildProxyConfig() {
  const httpProxy =
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    "";
  const httpsProxy =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    "";
  const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";

  return {
    httpProxy,
    httpsProxy,
    noProxy,
    proxyServer: httpsProxy || httpProxy || "",
    proxyBypassList: noProxy
      .split(/[;,]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join(";"),
  };
}

ensureRuntimePatches();

const codexBinary = assertExists(resolveCodexBinary(), "Codex CLI binary");
const proxyConfig = buildProxyConfig();
const env = {
  ...process.env,
  BUILD_FLAVOR: process.env.BUILD_FLAVOR || "prod",
  CODEX_CLI_PATH: process.env.CODEX_CLI_PATH || codexBinary,
  CODEX_FORCE_PACKAGED: "1",
  ELECTRON_IS_DEV: "0",
  NODE_ENV: process.env.NODE_ENV || "production",
  NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${electronBootstrap}`]
    .filter(Boolean)
    .join(" "),
  PATH: [rootDir, process.env.PATH].filter(Boolean).join(path.delimiter),
};

if (proxyConfig.httpProxy) {
  env.HTTP_PROXY = proxyConfig.httpProxy;
}

if (proxyConfig.httpsProxy) {
  env.HTTPS_PROXY = proxyConfig.httpsProxy;
}

if (proxyConfig.noProxy) {
  env.NO_PROXY = proxyConfig.noProxy;
}

const args = [
  electronCli,
  appDir,
  ...(proxyConfig.proxyServer ? [`--proxy-server=${proxyConfig.proxyServer}`] : []),
  ...(proxyConfig.proxyBypassList ? [`--proxy-bypass-list=${proxyConfig.proxyBypassList}`] : []),
  ...process.argv.slice(2),
];

const child = spawn(process.execPath, args, {
  cwd: appDir,
  env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
