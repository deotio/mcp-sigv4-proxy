import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import readline from 'readline';

export const MAX_SSE_BUFFER_BYTES = 1_048_576; // 1 MB
const DEFAULT_TIMEOUT_MS = 180_000; // 180s, matches AWS proxy
const DEFAULT_RETRIES = 2;
const RETRY_BASE_MS = 1000;
const COLD_START_RETRY_MS = 5000;

// Warm mode defaults
const DEFAULT_WARM_RETRIES = 5;
const DEFAULT_WARM_RETRY_DELAY_MS = 10_000;
const DEFAULT_WARM_TIMEOUT_MS = 300_000; // 5 min

// --- Log levels ---

export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'SILENT';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARNING: 2,
  ERROR: 3,
  SILENT: 4,
};

let currentLogLevel: LogLevel = 'ERROR';

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function log(level: LogLevel, message: string): void {
  if (LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[currentLogLevel]) {
    process.stderr.write(`mcp-sigv4-proxy: ${message}\n`);
  }
}

// --- URL parsing ---

export function parseEndpointUrl(hostname: string): { service: string; region: string } | null {
  const parts = hostname.split('.');

  // bedrock-agentcore.us-east-1.amazonaws.com
  if (parts.length >= 4 && parts.at(-2) === 'amazonaws' && parts.at(-1) === 'com') {
    const service = parts.slice(0, -3).join('.');
    const region = parts.at(-3)!;
    if (service && region) return { service, region };
  }

  // service.region.api.aws
  if (parts.length === 4 && parts[2] === 'api' && parts[3] === 'aws') {
    return { service: parts[0], region: parts[1] };
  }

  return null;
}

// --- Config ---

export interface ProxyConfig {
  url: URL;
  region: string;
  service: string;
  timeoutMs: number;
  retries: number;
  warm: boolean;
  warmRetries: number;
  warmRetryDelayMs: number;
  warmTimeoutMs: number;
}

export function validateEnv(): ProxyConfig {
  if (!process.env.MCP_SERVER_URL) {
    process.stderr.write('mcp-sigv4-proxy: MCP_SERVER_URL is required\n');
    process.exit(1);
  }

  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    process.stderr.write(
      'mcp-sigv4-proxy: NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed — ' +
        'this proxy sends signed AWS credentials and requires verified TLS\n',
    );
    process.exit(1);
  }

  const url = new URL(process.env.MCP_SERVER_URL);

  // Allow http:// for localhost (local development), require https:// for everything else
  const isLocalhost =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalhost)) {
    process.stderr.write(
      `mcp-sigv4-proxy: MCP_SERVER_URL must use https:// (got ${url.protocol})\n`,
    );
    process.exit(1);
  }

  // Infer service and region from hostname, fall back to env vars / defaults
  const inferred = parseEndpointUrl(url.hostname);

  const region = process.env.AWS_REGION || inferred?.region || 'us-east-1';
  const service = process.env.AWS_SERVICE || inferred?.service || 'bedrock-agentcore';

  // Parse log level
  const envLogLevel = (process.env.MCP_LOG_LEVEL ?? 'ERROR').toUpperCase();
  if (envLogLevel in LOG_LEVEL_ORDER) {
    setLogLevel(envLogLevel as LogLevel);
  }

  // Parse timeout
  const timeoutMs = process.env.MCP_TIMEOUT
    ? Number(process.env.MCP_TIMEOUT) * 1000
    : DEFAULT_TIMEOUT_MS;

  // Parse retries
  const retries = process.env.MCP_RETRIES
    ? Math.min(Math.max(0, Math.floor(Number(process.env.MCP_RETRIES))), 10)
    : DEFAULT_RETRIES;

  // Parse warm mode
  const warm = process.env.MCP_WARM === '1';
  const warmRetries = process.env.MCP_WARM_RETRIES
    ? Math.min(Math.max(0, Math.floor(Number(process.env.MCP_WARM_RETRIES))), 20)
    : DEFAULT_WARM_RETRIES;
  const warmRetryDelayMs = process.env.MCP_WARM_RETRY_DELAY
    ? Math.max(1000, Number(process.env.MCP_WARM_RETRY_DELAY))
    : DEFAULT_WARM_RETRY_DELAY_MS;
  const warmTimeoutMs = process.env.MCP_WARM_TIMEOUT
    ? Number(process.env.MCP_WARM_TIMEOUT)
    : DEFAULT_WARM_TIMEOUT_MS;

  log('INFO', `target: ${url.hostname}, service: ${service}, region: ${region}`);
  if (inferred) {
    log('DEBUG', `inferred service=${inferred.service}, region=${inferred.region} from URL`);
  }
  log('DEBUG', `timeout: ${timeoutMs}ms, retries: ${retries}`);
  if (warm) {
    log('INFO', `warm mode enabled (retries: ${warmRetries}, delay: ${warmRetryDelayMs}ms, timeout: ${warmTimeoutMs}ms)`);
  }

  return { url, region, service, timeoutMs, retries, warm, warmRetries, warmRetryDelayMs, warmTimeoutMs };
}

export function createSigner(config: ProxyConfig): SignatureV4 {
  return new SignatureV4({
    credentials: fromNodeProviderChain(),
    region: config.region,
    service: config.service,
    sha256: Sha256,
  });
}

// --- Input parsing ---

export function parseInputLine(line: string): { body: string; requestId: unknown } | null {
  const body = line.trim();
  if (!body) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    log('WARNING', 'ignoring non-JSON input line');
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as Record<string, unknown>).jsonrpc !== '2.0'
  ) {
    log('WARNING', 'ignoring non-JSON-RPC message');
    return null;
  }

  const requestId = (parsed as Record<string, unknown>).id ?? null;
  return { body, requestId };
}

// --- Request building ---

export function buildHttpRequest(url: URL, body: string): HttpRequest {
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  return new HttpRequest({
    method: 'POST',
    hostname: url.hostname,
    path: url.pathname,
    ...(Object.keys(query).length > 0 && { query }),
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
      host: url.hostname,
    },
    body,
  });
}

// --- Fetch with timeout and retries ---

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  retries: number,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, init, timeoutMs);

      // Retry on 5xx server errors and 424 (AgentCore cold-start timeout)
      const retryable = response.status >= 500 || response.status === 424;
      if (retryable && attempt < retries) {
        const delay = response.status === 424
          ? COLD_START_RETRY_MS * Math.pow(2, attempt)
          : RETRY_BASE_MS * Math.pow(2, attempt);
        log('WARNING', `HTTP ${response.status}, retrying in ${delay}ms (${attempt + 1}/${retries})`);
        await sleep(delay);
        continue;
      }

      return response;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        const isTimeout =
          err instanceof DOMException && err.name === 'AbortError';
        log(
          'WARNING',
          `request ${isTimeout ? 'timed out' : 'failed'}, retrying (${attempt + 1}/${retries})`,
        );
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Response handling ---

export async function handleResponse(response: Response, requestId: unknown): Promise<void> {
  if (!response.ok) {
    const text = await response.text();
    log('ERROR', `HTTP ${response.status}: ${text}`);

    // Extract the upstream message for the JSON-RPC error (if JSON, use .message; otherwise trim)
    let detail = '';
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.message === 'string') detail = `: ${parsed.message}`;
    } catch {
      const trimmed = text.trim();
      if (trimmed.length > 0 && trimmed.length <= 200) detail = `: ${trimmed}`;
    }

    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message: `HTTP ${response.status}${detail}` },
      }) + '\n',
    );
    return;
  }

  const ct = response.headers.get('content-type') ?? '';

  if (ct.includes('text/event-stream')) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      if (Buffer.byteLength(buffer) > MAX_SSE_BUFFER_BYTES) {
        log('ERROR', 'SSE buffer exceeded 1 MB limit, aborting stream');
        reader.cancel();
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
            error: { code: -32000, message: 'SSE stream exceeded buffer limit' },
          }) + '\n',
        );
        break;
      }

      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          try {
            JSON.parse(data);
            process.stdout.write(data + '\n');
          } catch {
            log('WARNING', `dropping non-JSON SSE data: ${data.slice(0, 100)}`);
          }
        }
      }
    }
  } else {
    const text = await response.text();
    const trimmed = text.trim();
    try {
      JSON.parse(trimmed);
      process.stdout.write(trimmed + '\n');
    } catch {
      log('WARNING', `dropping non-JSON response body: ${trimmed.slice(0, 100)}`);
    }
  }
}

// --- Request processing ---

export async function processLine(
  line: string,
  config: ProxyConfig,
  signer: SignatureV4,
): Promise<void> {
  const input = parseInputLine(line);
  if (!input) return;

  const { body, requestId } = input;
  const request = buildHttpRequest(config.url, body);

  try {
    const signed = await signer.sign(request);

    log('DEBUG', `-> POST ${config.url.pathname}`);

    const response = await fetchWithRetry(
      config.url.toString(),
      {
        method: 'POST',
        headers: signed.headers as Record<string, string>,
        body,
      },
      config.timeoutMs,
      config.retries,
    );

    await handleResponse(response, requestId);
  } catch (err) {
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';
    const message = isTimeout ? 'Request timed out' : 'Proxy request failed';
    log('ERROR', `request failed: ${err}`);
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message },
      }) + '\n',
    );
  }
}

// --- Warm mode ---

type WarmMethod = 'initialize' | 'tools/list' | 'resources/list' | 'prompts/list';
const WARM_CACHEABLE: ReadonlySet<string> = new Set<WarmMethod>([
  'initialize', 'tools/list', 'resources/list', 'prompts/list',
]);

interface WarmState {
  /** Resolves to true if warm mode is active, false if it fell back to pass-through */
  ready: Promise<boolean>;
  cache: Partial<Record<WarmMethod, unknown>>;
  active: boolean;
}

// Exported for testing
export { syntheticInitializeResult };

/**
 * Synthetic MCP initialize response returned when the backend hasn't responded yet.
 * Advertises tools/resources/prompts capabilities so Claude Code proceeds to list calls.
 */
function syntheticInitializeResult(): unknown {
  return {
    protocolVersion: '2025-03-26',
    capabilities: { tools: {}, resources: {}, prompts: {} },
    serverInfo: { name: 'mcp-sigv4-proxy-warm', version: '0.4.1' },
  };
}

export async function warmBackend(
  config: ProxyConfig,
  signer: SignatureV4,
): Promise<WarmState> {
  const state: WarmState = { ready: Promise.resolve(false), cache: {}, active: false };

  state.ready = (async (): Promise<boolean> => {
    const deadline = Date.now() + config.warmTimeoutMs;

    // Step 1: Initialize the backend (retry through cold-start 424s)
    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: '__warmup_init__',
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'mcp-sigv4-proxy', version: '0.4.0' },
      },
    });

    let initResponse: Response | null = null;
    for (let attempt = 0; attempt <= config.warmRetries; attempt++) {
      if (Date.now() >= deadline) break;
      try {
        const request = buildHttpRequest(config.url, initBody);
        const signed = await signer.sign(request);
        initResponse = await fetchWithTimeout(
          config.url.toString(),
          { method: 'POST', headers: signed.headers as Record<string, string>, body: initBody },
          Math.min(config.timeoutMs, deadline - Date.now()),
        );

        if (initResponse.ok) break;

        if (initResponse.status === 424 && attempt < config.warmRetries) {
          const delay = config.warmRetryDelayMs * Math.pow(2, attempt);
          log('INFO', `warm: cold-start (HTTP 424), retrying in ${delay}ms (${attempt + 1}/${config.warmRetries})`);
          await sleep(Math.min(delay, deadline - Date.now()));
          initResponse = null;
          continue;
        }

        log('WARNING', `warm: initialize failed with HTTP ${initResponse.status}`);
        return false;
      } catch (err) {
        if (attempt < config.warmRetries) {
          const delay = config.warmRetryDelayMs * Math.pow(2, attempt);
          log('WARNING', `warm: initialize error (${err}), retrying in ${delay}ms`);
          await sleep(Math.min(delay, deadline - Date.now()));
          continue;
        }
        log('ERROR', `warm: initialize failed after ${config.warmRetries} retries: ${err}`);
        return false;
      }
    }

    if (!initResponse?.ok) {
      log('ERROR', 'warm: backend did not respond to initialize within timeout');
      return false;
    }

    // Check for session ID — warm mode is incompatible with stateful servers
    const sessionId = initResponse.headers.get('mcp-session-id');
    if (sessionId) {
      log('WARNING', 'warm: backend returned mcp-session-id header — stateful servers are not '
        + 'compatible with warm mode. Falling back to pass-through mode.');
      return false;
    }

    // Cache the initialize result (extract from JSON-RPC response wrapper)
    try {
      const body = await initResponse.text();
      const parsed = JSON.parse(body);
      if (parsed.result) {
        state.cache.initialize = parsed.result;
      } else {
        state.cache.initialize = syntheticInitializeResult();
      }
    } catch {
      state.cache.initialize = syntheticInitializeResult();
    }

    log('INFO', 'warm: backend initialized, prefetching capability lists');

    // Step 2: Prefetch tools/list, resources/list, prompts/list
    const listMethods: WarmMethod[] = ['tools/list', 'resources/list', 'prompts/list'];
    await Promise.all(listMethods.map(async (method) => {
      try {
        const listBody = JSON.stringify({
          jsonrpc: '2.0', id: `__warmup_${method}__`, method, params: {},
        });
        const request = buildHttpRequest(config.url, listBody);
        const signed = await signer.sign(request);
        const response = await fetchWithTimeout(
          config.url.toString(),
          { method: 'POST', headers: signed.headers as Record<string, string>, body: listBody },
          Math.min(config.timeoutMs, Math.max(1000, deadline - Date.now())),
        );
        if (response.ok) {
          const body = await response.text();
          const parsed = JSON.parse(body);
          if (parsed.result) {
            state.cache[method] = parsed.result;
            log('DEBUG', `warm: cached ${method} (${JSON.stringify(parsed.result).length} bytes)`);
          }
        }
      } catch (err) {
        log('WARNING', `warm: failed to prefetch ${method}: ${err}`);
      }
    }));

    state.active = true;
    const cached = Object.keys(state.cache).length;
    log('INFO', `warm: ready (${cached} responses cached)`);
    return true;
  })();

  return state;
}

/**
 * Process a line in warm mode. Returns true if the message was handled locally
 * (from cache or synthetic response), false if it should be forwarded to the backend.
 */
export function tryWarmResponse(
  body: string,
  requestId: unknown,
  warmState: WarmState,
): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }

  const method = parsed.method as string | undefined;
  if (!method || !WARM_CACHEABLE.has(method)) return false;

  const cached = warmState.cache[method as WarmMethod];
  if (!cached) return false;

  // Respond from cache
  const response = JSON.stringify({
    jsonrpc: '2.0',
    id: requestId,
    result: cached,
  });
  process.stdout.write(response + '\n');
  log('DEBUG', `warm: served ${method} from cache`);

  // For initialize, also send the initialized notification to the backend (fire-and-forget).
  // Claude Code sends this too, but in warm mode we intercepted initialize so we handle it.
  return true;
}

/**
 * Handle a single parsed JSON-RPC message in warm mode.
 * Returns true if the message was served locally (no need to forward to backend).
 */
export async function handleWarmLine(
  input: { body: string; requestId: unknown },
  ws: WarmState,
): Promise<boolean> {
  const method = (JSON.parse(input.body) as Record<string, unknown>).method as string;

  if (method === 'initialize') {
    // Respond IMMEDIATELY — never block on ws.ready here.
    // This is the critical path: Claude Code's 30s timeout applies to this response.
    const result = ws.cache.initialize ?? syntheticInitializeResult();
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: input.requestId, result }) + '\n',
    );
    log('DEBUG', `warm: served initialize ${ws.cache.initialize ? 'from cache' : 'synthetic'}`);
    return true;
  }

  if (WARM_CACHEABLE.has(method)) {
    // List methods: serve from cache immediately if available…
    if (tryWarmResponse(input.body, input.requestId, ws)) return true;
    // …otherwise wait for warm-up to complete, then try cache again before forwarding
    await ws.ready;
    if (tryWarmResponse(input.body, input.requestId, ws)) return true;
    // Fall through to forward if warm-up failed or cache still empty
  }
  // Non-cacheable methods (tools/call etc): return false to forward normally.
  // fetchWithRetry handles any residual 424s if the backend isn't warm yet.
  return false;
}

// --- Main entry ---

export function startProxy(): void {
  const config = validateEnv();
  const signer = createSigner(config);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  // Start warm-up immediately. warmBackend() has no awaits before returning the WarmState
  // object, so this promise resolves in the next microtask — effectively instant. The
  // warmState.ready promise inside it is what takes minutes to resolve.
  const warmStateP: Promise<WarmState> | null = config.warm
    ? warmBackend(config, signer)
    : null;

  let pending: Promise<void> = Promise.resolve();

  rl.on('line', (line) => {
    pending = pending.then(async () => {
      if (warmStateP) {
        const input = parseInputLine(line);
        if (input) {
          const ws = await warmStateP; // resolves almost instantly
          if (await handleWarmLine(input, ws)) return;
        }
      }
      await processLine(line, config, signer);
    }).catch(() => {});
  });

  rl.on('close', async () => {
    log('INFO', 'stdin closed, draining in-flight requests');
    await pending;
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('INFO', 'received SIGTERM, shutting down');
    rl.close();
  });

  process.on('SIGINT', () => {
    log('INFO', 'received SIGINT, shutting down');
    rl.close();
  });
}
