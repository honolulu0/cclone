const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { URL } = require("node:url");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_BRIDGE_LOG_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "cclone-control-v3",
  "data",
  "logs",
  "request-bridge.ndjson",
);

let activeServer = null;

function startExternalApiServer({ appServerConnection, windowContext }) {
  if (activeServer != null) {
    return activeServer;
  }

  const host = (process.env.CODEX_EXTERNAL_API_HOST || DEFAULT_HOST).trim() || DEFAULT_HOST;
  const port = parsePort(process.env.CODEX_EXTERNAL_API_PORT, DEFAULT_PORT);
  const token = normalizeOptionalString(process.env.CODEX_EXTERNAL_API_TOKEN);
  const requestBridge = createRequestBridge(appServerConnection);

  const server = http.createServer((req, res) => {
    handleRequest({
      req,
      res,
      appServerConnection,
      requestBridge,
      windowContext,
      token,
    }).catch((error) => {
      if (error?.expected === true) {
        console.warn(`[cclone][external-api] request handled\n${error.message || String(error)}`);
      } else {
        console.error(`[cclone][external-api] request failed\n${formatError(error)}`);
      }
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
      requestBridge.dispose();
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
  requestBridge,
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

  if (req.method === "GET" && pathname === "/api/debug/app-server-connection") {
    writeJson(res, 200, describeAppServerConnection(appServerConnection));
    return;
  }

  if (req.method === "GET" && pathname === "/api/debug/pending-requests") {
    writeJson(res, 200, describePendingRequests(appServerConnection));
    return;
  }

  if (req.method === "GET" && pathname === "/api/debug/request-bridge") {
    writeJson(res, 200, requestBridge.getDebugState());
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

  if (req.method === "GET" && pathname === "/api/config") {
    const result = await appServerConnection.sendAppServerRequest("config/read", {
      includeLayers: parseBoolean(url.searchParams.get("includeLayers")),
      cwd: normalizeOptionalString(url.searchParams.get("cwd")) ?? null,
    });
    writeJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && pathname === "/api/config/requirements") {
    const result = await appServerConnection.sendAppServerRequest("configRequirements/read", {});
    writeJson(res, 200, result);
    return;
  }

  if (req.method === "PUT" && pathname === "/api/config") {
    const body = await readJsonBody(req);
    const result = await appServerConnection.sendAppServerRequest("config/batchWrite", body);
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
    const thread = await readThreadEnsuringAvailability({
      appServerConnection,
      threadId,
      includeTurns,
    });
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

  const messageStreamMatch = pathname.match(/^\/api\/threads\/([^/]+)\/messages\/stream$/);
  if (req.method === "POST" && messageStreamMatch) {
    const body = await readJsonBody(req);
    const threadId = decodeURIComponent(messageStreamMatch[1]);
    await handleChatStreamRequest({
      req,
      res,
      appServerConnection,
      body: {
        ...body,
        threadId,
      },
    });
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

  const threadEventsMatch = pathname.match(/^\/api\/threads\/([^/]+)\/events$/);
  if (req.method === "GET" && threadEventsMatch) {
    const threadId = decodeURIComponent(threadEventsMatch[1]);
    await handleThreadEventsRequest({
      req,
      res,
      appServerConnection,
      threadId,
      includeTurns: parseBoolean(url.searchParams.get("includeTurns")),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/thread-events") {
    await handleGlobalThreadEventsRequest({
      req,
      res,
      appServerConnection,
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/thread-requests") {
    await handleThreadRequestsRequest({
      req,
      res,
      requestBridge,
    });
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
  const sse = createSseSession({ req, res });
  const { sendEvent, close } = sse;
  const state = {
    turnId: null,
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
    close();
  }
}

async function handleThreadEventsRequest({
  req,
  res,
  appServerConnection,
  threadId,
  includeTurns,
}) {
  const sse = createSseSession({ req, res, keepAliveMs: 15000 });
  const { sendEvent, isClosed, close } = sse;
  let unsubscribe = null;

  try {
    const thread = await readThreadEnsuringAvailability({
      appServerConnection,
      threadId,
      includeTurns,
    });
    sendEvent("thread.snapshot", {
      threadId,
      thread: thread?.thread ?? thread ?? null,
    });

    unsubscribe = appServerConnection.registerInternalNotificationHandler((notification) => {
      if (isClosed()) {
        return;
      }

      const mapped = mapThreadNotificationToEvent(notification, threadId);
      if (!mapped) {
        return;
      }

      sendEvent(mapped.event, mapped.payload);
    });

    await waitForRequestClose(req);
  } finally {
    unsubscribe?.();
    close();
  }
}

async function handleGlobalThreadEventsRequest({
  req,
  res,
  appServerConnection,
}) {
  const sse = createSseSession({ req, res, keepAliveMs: 15000 });
  const { sendEvent, isClosed, close } = sse;
  let unsubscribe = null;

  try {
    sendEvent("thread.feed.ready", {
      timestamp: new Date().toISOString(),
    });

    unsubscribe = appServerConnection.registerInternalNotificationHandler((notification) => {
      if (isClosed()) {
        return;
      }

      const mapped = mapAnyThreadNotificationToEvent(notification);
      if (!mapped) {
        return;
      }

      sendEvent(mapped.event, mapped.payload);
    });

    await waitForRequestClose(req);
  } finally {
    unsubscribe?.();
    close();
  }
}

async function handleThreadRequestsRequest({
  req,
  res,
  requestBridge,
}) {
  const sse = createSseSession({ req, res, keepAliveMs: 15000 });
  const { sendEvent, isClosed, close } = sse;

  const unsubscribe = requestBridge.subscribe((eventName, payload) => {
    if (isClosed()) {
      return;
    }
    sendEvent(eventName, payload);
  });

  try {
    sendEvent("request.snapshot", {
      requests: requestBridge.listRequests(),
    });
    await waitForRequestClose(req);
  } finally {
    unsubscribe();
    close();
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

async function readThreadEnsuringAvailability({
  appServerConnection,
  threadId,
  includeTurns,
}) {
  try {
    return await appServerConnection.readThread(threadId, { includeTurns });
  } catch (error) {
    if (includeTurns && isThreadTurnsUnavailableError(error)) {
      const thread = await appServerConnection.readThread(threadId, { includeTurns: false });
      return {
        ...thread,
        thread: thread?.thread
          ? {
              ...thread.thread,
              turns: [],
            }
          : undefined,
        turns: Array.isArray(thread?.turns) ? [] : thread?.turns,
      };
    }

    if (!isThreadNotFoundError(error) || !normalizeOptionalString(threadId)) {
      throw error;
    }

    const metadata = await findThreadMetadataById({ appServerConnection, threadId });
    if (!metadata) {
      throw expectedHttpError(404, `thread unavailable: ${threadId}`);
    }
    await appServerConnection.resumeThread(threadId, {
      cwd: metadata?.cwd ?? null,
      path: metadata?.path ?? null,
      developerInstructions: null,
      persistExtendedHistory: false,
    });

    try {
      return await appServerConnection.readThread(threadId, { includeTurns });
    } catch (resumeError) {
      if (isThreadNotFoundError(resumeError)) {
        throw expectedHttpError(404, `thread unavailable: ${threadId}`);
      }
      throw resumeError;
    }
  }
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

    const metadata = await findThreadMetadataById({ appServerConnection, threadId });
    if (!metadata) {
      throw expectedHttpError(409, `thread unavailable for send: ${threadId}`);
    }
    await appServerConnection.resumeThread(threadId, {
      cwd: nullableValue(body.cwd) ?? metadata?.cwd ?? null,
      path: metadata?.path ?? null,
      developerInstructions: nullableValue(body.developerInstructions),
      persistExtendedHistory: false,
    });

    try {
      return await appServerConnection.startTurn(turnRequest);
    } catch (resumeError) {
      if (isThreadNotFoundError(resumeError)) {
        throw expectedHttpError(409, `thread unavailable for send: ${threadId}`);
      }
      throw resumeError;
    }
  }
}

async function findThreadMetadataById({
  appServerConnection,
  threadId,
  limit = 200,
  maxPages = 20,
}) {
  let cursor = null;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await appServerConnection.sendAppServerRequest("thread/list", {
      limit,
      cursor,
      archived: false,
    });
    const rows = Array.isArray(result?.data) ? result.data : [];
    const match = rows.find((row) => row?.id === threadId) || null;
    if (match) {
      return match;
    }

    cursor = normalizeOptionalString(result?.nextCursor);
    if (!cursor) {
      break;
    }
  }

  return null;
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

function createSseSession({ req, res, keepAliveMs = 0 }) {
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
  };

  const onClose = () => {
    state.closed = true;
  };

  req.on("close", onClose);
  req.on("aborted", onClose);

  const keepAlive =
    keepAliveMs > 0
      ? setInterval(() => {
          if (state.closed) {
            return;
          }
          res.write(": keepalive\n\n");
        }, keepAliveMs)
      : null;

  return {
    sendEvent(event, payload) {
      if (state.closed) {
        return;
      }

      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    isClosed() {
      return state.closed;
    },
    close() {
      req.off("close", onClose);
      req.off("aborted", onClose);
      if (keepAlive) {
        clearInterval(keepAlive);
      }
      if (!state.closed) {
        state.closed = true;
        res.end();
      }
    },
  };
}

function waitForRequestClose(req) {
  return new Promise((resolve) => {
    const cleanup = () => {
      req.off("close", onClose);
      req.off("aborted", onAborted);
    };

    const onClose = () => {
      cleanup();
      resolve();
    };

    const onAborted = () => {
      cleanup();
      resolve();
    };

    req.on("close", onClose);
    req.on("aborted", onAborted);
  });
}

function mapThreadNotificationToEvent(notification, threadId) {
  const params = notification?.params;
  if (params?.threadId !== threadId) {
    return null;
  }

  return mapAnyThreadNotificationToEvent(notification);
}

function mapAnyThreadNotificationToEvent(notification) {
  const params = notification?.params;
  const threadId = normalizeOptionalString(params?.threadId);
  if (!threadId) {
    return null;
  }

  switch (notification.method) {
    case "thread/status/changed":
      return {
        event: "thread.status",
        payload: {
          threadId,
          status: params.status ?? null,
        },
      };
    case "turn/started":
      return {
        event: "turn.started",
        payload: {
          threadId,
          turnId: params.turn?.id ?? params.turnId ?? null,
          turn: params.turn ?? null,
        },
      };
    case "turn/completed":
      return {
        event: "turn.completed",
        payload: {
          threadId,
          turnId: params.turn?.id ?? params.turnId ?? null,
          turn: params.turn ?? null,
        },
      };
    case "item/started":
      return {
        event: "item.started",
        payload: {
          threadId,
          turnId: params.turnId ?? null,
          item: params.item ?? null,
        },
      };
    case "item/completed":
      return {
        event: "item.completed",
        payload: {
          threadId,
          turnId: params.turnId ?? null,
          item: params.item ?? null,
        },
      };
    case "item/agentMessage/delta":
      return {
        event: "item.delta",
        payload: {
          threadId,
          turnId: params.turnId ?? null,
          itemId: params.itemId ?? null,
          delta: typeof params.delta === "string" ? params.delta : "",
        },
      };
    case "thread/archived":
      return {
        event: "thread.archived",
        payload: {
          threadId,
        },
      };
    case "thread/unarchived":
      return {
        event: "thread.unarchived",
        payload: {
          threadId,
        },
      };
    case "error":
      return {
        event: "thread.error",
        payload: {
          threadId,
          error: params.error ?? null,
          turnId: params.turnId ?? null,
        },
      };
    default:
      return null;
  }
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

function createRequestBridge(appServerConnection) {
  const requests = new Map();
  const listeners = new Set();
  const originalHandleClientRequestMethod = typeof appServerConnection.handleClientRequest === "function"
    ? appServerConnection.handleClientRequest
    : null;
  const originalHandleClientRequest = originalHandleClientRequestMethod == null
    ? null
    : originalHandleClientRequestMethod.bind(appServerConnection);
  const originalRouteIncomingMessageMethod = typeof appServerConnection.routeIncomingMessage === "function"
    ? appServerConnection.routeIncomingMessage
    : null;
  const originalRouteIncomingMessage = originalRouteIncomingMessageMethod == null
    ? null
    : originalRouteIncomingMessageMethod.bind(appServerConnection);
  const debugState = {
    handledClientRequestCount: 0,
    routedIncomingMessageCount: 0,
    matchedClientRequestMethods: [],
    matchedIncomingMethods: [],
    lastClientRequest: null,
    lastIncomingMessage: null,
  };

  const notify = (eventName, payload) => {
    for (const listener of listeners) {
      listener(eventName, payload);
    }
  };

  const upsertRequest = (request) => {
    const normalized = normalizeRequestRecord(request);
    if (!normalized) {
      writeRequestBridgeLog({
        kind: "request.ignored",
        source: "handleClientRequest",
        raw: summarizeRawRequest(request),
      });
      return;
    }
    requests.set(normalized.id, normalized);
    writeRequestBridgeLog({
      kind: "request.created",
      source: "handleClientRequest",
      request: normalized,
    });
    notify("request.created", normalized);
  };

  const resolveRequest = (requestId, threadId) => {
    const normalizedRequestId = normalizeRequestId(requestId);
    if (!normalizedRequestId) {
      return;
    }

    requests.delete(normalizedRequestId);
    writeRequestBridgeLog({
      kind: "request.resolved",
      source: "notification",
      requestId: normalizedRequestId,
      threadId: normalizeOptionalString(threadId),
    });
    notify("request.resolved", {
      requestId: normalizedRequestId,
      threadId: normalizeOptionalString(threadId),
    });
  };

  if (originalHandleClientRequest) {
    appServerConnection.handleClientRequest = function (...args) {
      const request = args[0];
      debugState.handledClientRequestCount += 1;
      debugState.lastClientRequest = summarizeRawRequest(request);
      const method = normalizeOptionalString(request?.method);
      writeRequestBridgeLog({
        kind: "handleClientRequest",
        matched: Boolean(method && isTrackedRequestMethod(method)),
        method: method || null,
        raw: summarizeRawRequest(request),
      });
      if (method && isTrackedRequestMethod(method)) {
        debugState.matchedClientRequestMethods.push(method);
        debugState.lastClientRequest = summarizeRawRequest(request);
      }
      upsertRequest(request);
      return originalHandleClientRequest(...args);
    };
  }

  if (originalRouteIncomingMessage) {
    appServerConnection.routeIncomingMessage = function (...args) {
      const message = args[0];
      debugState.routedIncomingMessageCount += 1;
      debugState.lastIncomingMessage = summarizeRawRequest(message);
      const method = normalizeOptionalString(message?.method);
      writeRequestBridgeLog({
        kind: "routeIncomingMessage",
        matched: Boolean(method && isTrackedRequestMethod(method)),
        method: method || null,
        raw: summarizeRawRequest(message),
      });
      if (method && isTrackedRequestMethod(method)) {
        debugState.matchedIncomingMethods.push(method);
        debugState.lastIncomingMessage = summarizeRawRequest(message);
        upsertRequest(message);
      }
      return originalRouteIncomingMessage(...args);
    };
  }

  const unsubscribeNotification = appServerConnection.registerInternalNotificationHandler((notification) => {
    if (notification?.method !== "serverRequest/resolved") {
      return;
    }

    const params = notification?.params || {};
    resolveRequest(params.requestId, params.threadId);
  });

  return {
    dispose() {
      if (originalHandleClientRequestMethod) {
        appServerConnection.handleClientRequest = originalHandleClientRequestMethod;
      }
      if (originalRouteIncomingMessageMethod) {
        appServerConnection.routeIncomingMessage = originalRouteIncomingMessageMethod;
      }
      unsubscribeNotification?.();
      listeners.clear();
      requests.clear();
    },
    getDebugState() {
      return {
        ...debugState,
        matchedClientRequestMethods: [...debugState.matchedClientRequestMethods],
        matchedIncomingMethods: [...debugState.matchedIncomingMethods],
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listRequests() {
      return [...requests.values()];
    },
  };
}

function normalizeRequestRecord(request) {
  if (!request || typeof request !== "object") {
    return null;
  }

  const id = normalizeRequestId(request.id);
  const method = normalizeOptionalString(request.method);
  const params = request.params && typeof request.params === "object" ? request.params : {};
  if (!id || !method) {
    return null;
  }

  const threadId = normalizeOptionalString(params.threadId);
  const turnId = normalizeOptionalString(params.turnId);
  const itemId = normalizeOptionalString(params.itemId);

  return {
    id,
    method,
    kind: classifyRequestMethod(method),
    threadId,
    turnId,
    itemId,
    createdAt: new Date().toISOString(),
    params,
  };
}

function classifyRequestMethod(method) {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "commandApproval";
    case "item/fileChange/requestApproval":
      return "fileApproval";
    case "item/tool/requestUserInput":
      return "userInput";
    case "mcpServer/elicitation/request":
      return "mcpElicitation";
    default:
      return "other";
  }
}

function describeAppServerConnection(appServerConnection) {
  const ownPropertyNames = Object.getOwnPropertyNames(appServerConnection || {});
  const prototype = Object.getPrototypeOf(appServerConnection);
  const ownDescriptors = Object.getOwnPropertyDescriptors(appServerConnection || {});
  const prototypeDescriptors = prototype == null ? {} : Object.getOwnPropertyDescriptors(prototype);

  const ownMethodNames = Object.entries(ownDescriptors)
    .filter(([, descriptor]) => typeof descriptor.value === "function")
    .map(([name]) => name);
  const prototypeMethodNames = Object.entries(prototypeDescriptors)
    .filter(([name, descriptor]) => name !== "constructor" && typeof descriptor.value === "function")
    .map(([name]) => name);

  const allMethodNames = [...new Set([...ownMethodNames, ...prototypeMethodNames])].sort();

  return {
    ownPropertyNames: ownPropertyNames.sort(),
    ownMethodNames: ownMethodNames.sort(),
    prototypeMethodNames: prototypeMethodNames.sort(),
    methodNames: allMethodNames,
    requestRelatedMethods: allMethodNames.filter((name) => /request|notification|approval|input/i.test(name)),
  };
}

function describePendingRequests(appServerConnection) {
  const pendingRequests = appServerConnection?.pendingRequests;
  if (!(pendingRequests instanceof Map)) {
    return {
      type: typeof pendingRequests,
      isMap: false,
      size: 0,
      items: [],
    };
  }

  const items = [];
  for (const [key, value] of pendingRequests.entries()) {
    items.push({
      key,
      valueType: typeof value,
      ownPropertyNames: value && typeof value === "object" ? Object.getOwnPropertyNames(value).sort() : [],
      summary: summarizePendingRequestValue(value),
    });
  }

  return {
    type: "object",
    isMap: true,
    size: pendingRequests.size,
    items,
  };
}

function summarizePendingRequestValue(value) {
  if (!value || typeof value !== "object") {
    return value;
  }

  const summary = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "params" && entry && typeof entry === "object") {
      summary.paramsKeys = Object.keys(entry).sort();
      summary.threadId = typeof entry.threadId === "string" ? entry.threadId : null;
      summary.turnId = typeof entry.turnId === "string" ? entry.turnId : null;
      continue;
    }

    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry == null) {
      summary[key] = entry;
    }
  }
  return summary;
}

function summarizeRawRequest(value) {
  if (!value || typeof value !== "object") {
    return value;
  }

  const summary = {
    ownPropertyNames: Object.getOwnPropertyNames(value).sort(),
  };

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry == null) {
      summary[key] = entry;
      continue;
    }

    if (key === "params" && entry && typeof entry === "object") {
      summary.paramsKeys = Object.keys(entry).sort();
      summary.threadId = typeof entry.threadId === "string" ? entry.threadId : null;
      summary.turnId = typeof entry.turnId === "string" ? entry.turnId : null;
      summary.itemId = typeof entry.itemId === "string" ? entry.itemId : null;
    }
  }

  return summary;
}

function isTrackedRequestMethod(method) {
  return [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/tool/requestUserInput",
    "mcpServer/elicitation/request",
  ].includes(method);
}

function normalizeRequestId(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

function writeRequestBridgeLog(entry) {
  try {
    fs.mkdirSync(path.dirname(REQUEST_BRIDGE_LOG_PATH), { recursive: true });
    fs.appendFileSync(
      REQUEST_BRIDGE_LOG_PATH,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
      "utf8",
    );
  } catch (error) {
    console.warn(`[cclone][external-api] request bridge log write failed\n${formatError(error)}`);
  }
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
  const message = formatError(error).toLowerCase();
  return (
    message.includes("thread not found") ||
    message.includes("thread not loaded") ||
    message.includes("no rollout found")
  );
}

function isThreadTurnsUnavailableError(error) {
  const message = formatError(error).toLowerCase();
  return (
    message.includes("includeTurns is unavailable".toLowerCase()) ||
    message.includes("not materialized yet")
  );
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

function expectedHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expected = true;
  return error;
}

module.exports = {
  startExternalApiServer,
};
