const http = require("node:http");
const { URL } = require("node:url");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;

let activeServer = null;

function startExternalApiServer({ appServerConnection, windowContext }) {
  if (activeServer != null) {
    return activeServer;
  }

  const host = (process.env.CODEX_EXTERNAL_API_HOST || DEFAULT_HOST).trim() || DEFAULT_HOST;
  const port = parsePort(process.env.CODEX_EXTERNAL_API_PORT, DEFAULT_PORT);
  const token = normalizeOptionalString(process.env.CODEX_EXTERNAL_API_TOKEN);

  const server = http.createServer((req, res) => {
    handleRequest({
      req,
      res,
      appServerConnection,
      windowContext,
      token,
    }).catch((error) => {
      console.error(`[cclone][external-api] request failed\n${formatError(error)}`);
      if (!res.headersSent) {
        writeJson(res, getErrorStatusCode(error), { error: error.message || String(error) });
        return;
      }

      try {
        res.end();
      } catch {
        // Ignore late response write failures.
      }
    });
  });

  server.on("error", (error) => {
    console.error(`[cclone][external-api] server error\n${formatError(error)}`);
  });

  server.listen(port, host, () => {
    console.log(
      `[cclone][external-api] listening on http://${host}:${port} ` +
        `(token ${token ? "required" : "disabled"})`,
    );
  });

  activeServer = {
    dispose() {
      server.close();
      activeServer = null;
    },
  };

  return activeServer;
}

async function handleRequest({
  req,
  res,
  appServerConnection,
  windowContext,
  token,
}) {
  applyCorsHeaders(res);
  console.log(`[cclone][external-api] ${req.method} ${req.url}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!authorizeRequest(req, token)) {
    writeJson(res, 401, {
      error: "Unauthorized",
      hint: "Provide Authorization: Bearer <CODEX_EXTERNAL_API_TOKEN>.",
    });
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/health") {
    writeJson(res, 200, {
      ok: true,
      service: "cclone-external-api",
      hostId: windowContext.hostId,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/models") {
    const result = await appServerConnection.listModels({
      includeHidden: true,
      cursor: null,
      limit: 100,
    });
    writeJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && pathname === "/api/collaboration-modes") {
    const result = await appServerConnection.sendAppServerRequest("collaborationMode/list", {});
    writeJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && pathname === "/api/threads") {
    const result = await listThreads({
      appServerConnection,
      query: url.searchParams,
    });
    writeJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/threads") {
    const body = await readJsonBody(req);
    const result = await appServerConnection.startThread(normalizeThreadStartRequest(body));
    writeJson(res, 200, result);
    return;
  }

  const threadMatch = pathname.match(/^\/api\/threads\/([^/]+)$/);
  if (req.method === "GET" && threadMatch) {
    const threadId = decodeURIComponent(threadMatch[1]);
    const includeTurns = parseBoolean(url.searchParams.get("includeTurns"));
    const thread = await appServerConnection.readThread(threadId, { includeTurns });
    writeJson(res, 200, { thread });
    return;
  }

  const interruptMatch = pathname.match(/^\/api\/threads\/([^/]+)\/interrupt$/);
  if (req.method === "POST" && interruptMatch) {
    const threadId = decodeURIComponent(interruptMatch[1]);
    const body = await readJsonBody(req);
    const result = await appServerConnection.interruptTurn({
      threadId,
      turnId: normalizeOptionalString(body.turnId),
    });
    writeJson(res, 200, result);
    return;
  }

  const renameMatch = pathname.match(/^\/api\/threads\/([^/]+)\/rename$/);
  if (req.method === "POST" && renameMatch) {
    const threadId = decodeURIComponent(renameMatch[1]);
    const body = await readJsonBody(req);
    const name = normalizeRequiredString(body.name, "name");
    const result = await appServerConnection.setThreadName(threadId, name);
    writeJson(res, 200, result);
    return;
  }

  const messageMatch = pathname.match(/^\/api\/threads\/([^/]+)\/messages$/);
  if (req.method === "POST" && messageMatch) {
    const body = await readJsonBody(req);
    const threadId = decodeURIComponent(messageMatch[1]);
    const result = await handleChatRequest({
      appServerConnection,
      body: {
        ...body,
        threadId,
      },
    });
    writeJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/chat") {
    const body = await readJsonBody(req);
    const result = await handleChatRequest({
      appServerConnection,
      body,
    });
    writeJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && pathname === "/api/chat/stream") {
    const body = await readJsonBody(req);
    await handleChatStreamRequest({
      req,
      res,
      appServerConnection,
      body,
    });
    return;
  }

  writeJson(res, 404, {
    error: "Not found",
    path: pathname,
  });
}

async function listThreads({ appServerConnection, query }) {
  const request = stripUndefined({
    limit: clampInteger(parsePositiveInteger(query.get("limit"), 50), 1, 200),
    cursor: normalizeOptionalString(query.get("cursor")),
    archived: parseBoolean(query.get("archived")),
    searchTerm:
      normalizeOptionalString(query.get("searchTerm")) ||
      normalizeOptionalString(query.get("search")) ||
      normalizeOptionalString(query.get("q")),
    sortKey: normalizeOptionalString(query.get("sortKey")) || "updated_at",
  });

  return appServerConnection.sendAppServerRequest("thread/list", request);
}

async function handleChatRequest({ appServerConnection, body }) {
  const threadId = await ensureThreadId({ appServerConnection, body });
  const turnRequest = normalizeTurnStartRequest(body, threadId);
  const turnStart = await startTurnEnsuringThreadAvailability({
    appServerConnection,
    threadId,
    turnRequest,
    body,
  });
  const turnId = turnStart?.turn?.id ?? null;

  if (body.waitForCompletion === false) {
    return {
      accepted: true,
      threadId,
      turnId,
      turn: turnStart.turn ?? null,
    };
  }

  const completion = await waitForTurnCompletion({
    appServerConnection,
    threadId,
    turnId,
    timeoutMs: parsePositiveInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS),
  });
  const thread = await appServerConnection
    .readThread(threadId, { includeTurns: true })
    .catch(() => null);

  return {
    threadId,
    turnId: completion.turnId,
    status: completion.status,
    assistantText: extractLastAssistantMessage(thread) || completion.assistantText,
    thread,
  };
}

async function handleChatStreamRequest({ req, res, appServerConnection, body }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const state = {
    closed: false,
    turnId: null,
  };

  const onClose = () => {
    state.closed = true;
  };

  req.on("close", onClose);
  req.on("aborted", onClose);

  const sendEvent = (event, payload) => {
    if (state.closed) {
      return;
    }

    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const threadId = await ensureThreadId({ appServerConnection, body });
    sendEvent("thread.ready", { threadId });

    const turnRequest = normalizeTurnStartRequest(body, threadId);
    const turnStart = await startTurnEnsuringThreadAvailability({
      appServerConnection,
      threadId,
      turnRequest,
      body,
    });
    state.turnId = turnStart?.turn?.id ?? null;
    sendEvent("turn.accepted", {
      threadId,
      turnId: state.turnId,
      turn: turnStart.turn ?? null,
    });

    const completion = await waitForTurnCompletion({
      appServerConnection,
      threadId,
      turnId: state.turnId,
      timeoutMs: parsePositiveInteger(body.timeoutMs, DEFAULT_TIMEOUT_MS),
      onEvent: (event, payload) => {
        sendEvent(event, payload);
      },
    });
    const thread = await appServerConnection
      .readThread(threadId, { includeTurns: true })
      .catch(() => null);

    sendEvent("done", {
      threadId,
      turnId: completion.turnId,
      status: completion.status,
      assistantText: extractLastAssistantMessage(thread) || completion.assistantText,
      thread,
    });
  } catch (error) {
    sendEvent("error", {
      error: error.message || String(error),
    });
  } finally {
    req.off("close", onClose);
    req.off("aborted", onClose);

    if (!state.closed) {
      res.end();
    }
  }
}

async function ensureThreadId({ appServerConnection, body }) {
  const existingThreadId = normalizeOptionalString(body.threadId);
  if (existingThreadId) {
    return existingThreadId;
  }

  const created = await startThreadWithRetry({
    appServerConnection,
    request: normalizeThreadStartRequest(body),
  });
  const createdThreadId = created?.thread?.id ?? null;
  if (!createdThreadId) {
    throw new Error("Failed to create thread.");
  }

  await waitForThreadAvailability({
    appServerConnection,
    threadId: createdThreadId,
  });

  return createdThreadId;
}

async function startTurnEnsuringThreadAvailability({
  appServerConnection,
  threadId,
  turnRequest,
  body,
}) {
  try {
    return await appServerConnection.startTurn(turnRequest);
  } catch (error) {
    if (!isThreadNotFoundError(error) || !normalizeOptionalString(threadId)) {
      throw error;
    }

    await appServerConnection.resumeThread(threadId, {
      cwd: nullableValue(body.cwd),
      developerInstructions: nullableValue(body.developerInstructions),
      persistExtendedHistory: false,
    });

    return appServerConnection.startTurn(turnRequest);
  }
}

function normalizeThreadStartRequest(body) {
  const source = body.createThread ?? body.thread ?? body;
  return {
    model: nullableValue(source.model),
    modelProvider: nullableValue(source.modelProvider),
    cwd: nullableValue(source.cwd),
    approvalPolicy: nullableValue(source.approvalPolicy),
    sandbox: normalizeThreadSandbox(source.sandbox ?? source.sandboxMode ?? source.sandboxPolicy),
    config: source.config ?? null,
    baseInstructions: nullableValue(source.baseInstructions),
    developerInstructions: nullableValue(source.developerInstructions),
    personality: source.personality ?? null,
    ephemeral: source.ephemeral === true,
    dynamicTools: source.dynamicTools ?? null,
    mockExperimentalField: source.mockExperimentalField ?? null,
    experimentalRawEvents: source.experimentalRawEvents === true,
    persistExtendedHistory: source.persistExtendedHistory === true,
    serviceTier: nullableValue(source.serviceTier),
  };
}

function normalizeTurnStartRequest(body, threadId) {
  return {
    threadId,
    input: normalizeInput(body),
    cwd: nullableValue(body.cwd),
    approvalPolicy: nullableValue(body.approvalPolicy),
    sandboxPolicy: normalizeTurnSandboxPolicy(body.sandboxPolicy ?? body.sandbox),
    model: nullableValue(body.model),
    effort: nullableValue(body.effort ?? body.reasoningEffort),
    serviceTier: nullableValue(body.serviceTier),
    summary: nullableValue(body.summary) ?? "auto",
    personality: body.personality ?? null,
    outputSchema: body.outputSchema ?? null,
    collaborationMode: body.collaborationMode ?? null,
  };
}

function normalizeInput(body) {
  if (Array.isArray(body.input)) {
    return body.input.map((item) => normalizeInputItem(item));
  }

  const text =
    normalizeOptionalString(body.message) ||
    normalizeOptionalString(body.prompt) ||
    normalizeOptionalString(body.text);

  if (!text) {
    throw new Error("Request body must include `message` or `input`.");
  }

  return [
    {
      type: "text",
      text,
      text_elements: [],
    },
  ];
}

function normalizeInputItem(item) {
  if (typeof item !== "object" || item == null) {
    throw new Error("Each input item must be an object.");
  }

  if (item.type === "text") {
    return {
      type: "text",
      text: normalizeRequiredString(item.text, "input[].text"),
      text_elements: Array.isArray(item.text_elements) ? item.text_elements : [],
    };
  }

  if (item.type === "image" || item.type === "localImage") {
    return {
      type: item.type,
      url: item.url ?? undefined,
      path: item.path ?? undefined,
    };
  }

  if (item.type === "skill" || item.type === "mention") {
    return {
      type: item.type,
      name: normalizeRequiredString(item.name, `input[].${item.type}.name`),
      path: normalizeRequiredString(item.path, `input[].${item.type}.path`),
    };
  }

  return item;
}

function normalizeThreadSandbox(value) {
  const normalized = normalizeOptionalString(value);
  return normalized || null;
}

function normalizeTurnSandboxPolicy(value) {
  if (value == null) {
    return null;
  }

  if (typeof value === "object") {
    return value;
  }

  switch (String(value).trim()) {
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    case "read-only":
      return { type: "readOnly" };
    case "workspace-write":
      return { type: "workspaceWrite" };
    default:
      return null;
  }
}

async function startThreadWithRetry({
  appServerConnection,
  request,
  retryDelayMs = 750,
}) {
  try {
    return await appServerConnection.startThread(request);
  } catch (error) {
    if (!isThreadStartTimeoutError(error)) {
      throw error;
    }

    await delay(retryDelayMs);
    return appServerConnection.startThread(request);
  }
}

async function waitForThreadAvailability({
  appServerConnection,
  threadId,
  attempts = 10,
  delayMs = 250,
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const thread = await appServerConnection
      .readThread(threadId, { includeTurns: false })
      .catch(() => null);

    if (thread != null) {
      return thread;
    }

    await delay(delayMs);
  }

  throw new Error(`Timed out waiting for thread availability after thread/start (${threadId}).`);
}

function waitForTurnCompletion({
  appServerConnection,
  threadId,
  turnId,
  timeoutMs,
  onEvent,
}) {
  let currentTurnId = turnId ?? null;
  let latestDeltaText = "";
  let latestAssistantText = null;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for turn completion after ${timeoutMs}ms.`));
    }, timeoutMs);

    const unsubscribe = appServerConnection.registerInternalNotificationHandler((notification) => {
      const params = notification?.params;
      if (params?.threadId !== threadId) {
        return;
      }

      switch (notification.method) {
        case "turn/started": {
          const startedTurnId = params.turn?.id ?? params.turnId ?? null;
          if (currentTurnId == null || startedTurnId === currentTurnId) {
            currentTurnId = startedTurnId;
            onEvent?.("turn.started", {
              threadId,
              turnId: currentTurnId,
              turn: params.turn ?? null,
            });
          }
          return;
        }
        case "item/agentMessage/delta": {
          if (!matchesTurn(params.turnId, currentTurnId)) {
            return;
          }

          const delta = typeof params.delta === "string" ? params.delta : "";
          latestDeltaText += delta;
          onEvent?.("agent.delta", {
            threadId,
            turnId: currentTurnId,
            delta,
            aggregatedText: latestDeltaText,
          });
          return;
        }
        case "item/completed": {
          if (!matchesTurn(params.turnId, currentTurnId)) {
            return;
          }

          if (params.item?.type === "agentMessage") {
            latestAssistantText = params.item.text ?? latestAssistantText;
            onEvent?.("agent.completed", {
              threadId,
              turnId: currentTurnId,
              text: latestAssistantText,
            });
          }
          return;
        }
        case "turn/completed": {
          const completedTurnId = params.turn?.id ?? params.turnId ?? currentTurnId;
          if (!matchesTurn(completedTurnId, currentTurnId)) {
            return;
          }

          cleanup();
          resolve({
            threadId,
            turnId: completedTurnId,
            status: params.turn?.status ?? "completed",
            assistantText: latestAssistantText || latestDeltaText || null,
          });
          return;
        }
        default:
          return;
      }
    });

    function cleanup() {
      clearTimeout(timeout);
      unsubscribe();
    }
  });
}

function matchesTurn(candidateTurnId, expectedTurnId) {
  if (expectedTurnId == null) {
    return true;
  }

  return candidateTurnId == null || candidateTurnId === expectedTurnId;
}

function extractLastAssistantMessage(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];

  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const items = Array.isArray(turns[turnIndex]?.items) ? turns[turnIndex].items : [];

    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        return item.text;
      }
    }
  }

  return null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;

    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`));
        req.destroy();
        return;
      }

      body += chunk.toString("utf8");
    });

    req.on("end", () => {
      if (body.trim().length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });

    req.on("error", reject);
  });
}

function authorizeRequest(req, token) {
  if (!token) {
    return true;
  }

  const authHeader = req.headers.authorization || "";
  const apiKeyHeader = req.headers["x-api-key"] || "";

  if (typeof authHeader === "string" && authHeader === `Bearer ${token}`) {
    return true;
  }

  if (typeof apiKeyHeader === "string" && apiKeyHeader === token) {
    return true;
  }

  return false;
}

function applyCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function writeJson(res, statusCode, payload) {
  if (!res.headersSent) {
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
    });
  }

  res.end(JSON.stringify(payload, null, 2));
}

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clampInteger(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseBoolean(value) {
  return value === "1" || value === "true";
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRequiredString(value, fieldName) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`Missing required field: ${fieldName}`);
  }

  return normalized;
}

function nullableValue(value) {
  return value == null ? null : value;
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null));
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isThreadStartTimeoutError(error) {
  const message = formatError(error);
  return message.includes("Timed out waiting for MCP response to thread/start");
}

function isThreadNotFoundError(error) {
  return formatError(error).toLowerCase().includes("thread not found");
}

function formatError(error) {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }

  return String(error);
}

function getErrorStatusCode(error) {
  return Number.isInteger(error?.statusCode) ? error.statusCode : 500;
}

module.exports = {
  startExternalApiServer,
};
