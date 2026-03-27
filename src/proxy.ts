import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import readline from 'readline';

export const MAX_SSE_BUFFER_BYTES = 1_048_576; // 1 MB
const DEFAULT_TIMEOUT_MS = 180_000; // 180s, matches AWS proxy
const DEFAULT_RETRIES = 0;
const RETRY_BASE_MS = 1000;

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

  log('INFO', `target: ${url.hostname}, service: ${service}, region: ${region}`);
  if (inferred) {
    log('DEBUG', `inferred service=${inferred.service}, region=${inferred.region} from URL`);
  }
  log('DEBUG', `timeout: ${timeoutMs}ms, retries: ${retries}`);

  return { url, region, service, timeoutMs, retries };
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

      // Only retry on 5xx server errors
      if (response.status >= 500 && attempt < retries) {
        log('WARNING', `HTTP ${response.status}, retrying (${attempt + 1}/${retries})`);
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
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
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message: `HTTP ${response.status}` },
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

// --- Main entry ---

export function startProxy(): void {
  const config = validateEnv();
  const signer = createSigner(config);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  let pending: Promise<void> = Promise.resolve();

  rl.on('line', (line) => {
    pending = pending.then(() => processLine(line, config, signer)).catch(() => {});
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
