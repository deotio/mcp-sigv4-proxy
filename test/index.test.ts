import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(__dirname, '..', 'dist', 'index.js');

// --- Helpers ---

function spawnProxy(
  env: Record<string, string>,
  opts?: { input?: string[]; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn('node', [BIN], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout!.on('data', (d) => (stdout += d.toString()));
    child.stderr!.on('data', (d) => (stderr += d.toString()));

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
    }, opts?.timeoutMs ?? 5000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });

    if (opts?.input) {
      for (const line of opts.input) {
        child.stdin!.write(line + '\n');
      }
      child.stdin!.end();
    } else {
      child.stdin!.end();
    }
  });
}

const baseEnv = {
  MCP_SERVER_URL: 'https://example.com',
  AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  AWS_REGION: 'us-east-1',
};

// --- Unit tests (import proxy.ts for coverage) ---

import {
  parseInputLine,
  buildHttpRequest,
  handleResponse,
  processLine,
  validateEnv,
  createSigner,
  MAX_SSE_BUFFER_BYTES,
} from '../src/proxy.js';

describe('parseInputLine', () => {
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => stderrSpy.mockRestore());

  test('returns null for empty string', () => {
    expect(parseInputLine('')).toBeNull();
    expect(parseInputLine('   ')).toBeNull();
  });

  test('returns null and warns for non-JSON', () => {
    expect(parseInputLine('not json')).toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith('mcp-sigv4-proxy: ignoring non-JSON input line\n');
  });

  test('returns null and warns for JSON without jsonrpc', () => {
    expect(parseInputLine('{"foo": "bar"}')).toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith('mcp-sigv4-proxy: ignoring non-JSON-RPC message\n');
  });

  test('returns null for wrong jsonrpc version', () => {
    expect(parseInputLine('{"jsonrpc": "1.0", "method": "test"}')).toBeNull();
  });

  test('returns null for array JSON', () => {
    expect(parseInputLine('[1, 2, 3]')).toBeNull();
  });

  test('returns null for null JSON', () => {
    expect(parseInputLine('null')).toBeNull();
  });

  test('parses valid JSON-RPC with id', () => {
    const result = parseInputLine('{"jsonrpc": "2.0", "method": "test", "id": 42}');
    expect(result).not.toBeNull();
    expect(result!.requestId).toBe(42);
    expect(result!.body).toBe('{"jsonrpc": "2.0", "method": "test", "id": 42}');
  });

  test('parses notification (no id) with requestId null', () => {
    const result = parseInputLine('{"jsonrpc": "2.0", "method": "notifications/initialized"}');
    expect(result).not.toBeNull();
    expect(result!.requestId).toBeNull();
  });
});

describe('buildHttpRequest', () => {
  test('builds correct HttpRequest', () => {
    const url = new URL('https://example.com/path?q=1');
    const body = '{"jsonrpc":"2.0","method":"test","id":1}';
    const req = buildHttpRequest(url, body);

    expect(req.method).toBe('POST');
    expect(req.hostname).toBe('example.com');
    expect(req.path).toBe('/path?q=1');
    // Smithy HttpRequest normalizes header names
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(headers['content-type']).toBe('application/json');
    expect(headers['host']).toBe('example.com');
    expect(headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(req.body).toBe(body);
  });
});

describe('handleResponse', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  test('HTTP error produces sanitized JSON-RPC error', async () => {
    const response = new Response('AccessDenied: you are not authorized', {
      status: 403,
      statusText: 'Forbidden',
    });

    await handleResponse(response, 1);

    // stderr gets full body
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('HTTP 403: AccessDenied'),
    );

    // stdout gets sanitized error with correct id
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.jsonrpc).toBe('2.0');
    expect(output.id).toBe(1);
    expect(output.error.code).toBe(-32000);
    expect(output.error.message).toBe('HTTP 403');
  });

  test('HTTP 500 produces sanitized error', async () => {
    const response = new Response('Internal Server Error details', {
      status: 500,
    });

    await handleResponse(response, 5);

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.id).toBe(5);
    expect(output.error.message).toBe('HTTP 500');
  });

  test('error with null id (notification)', async () => {
    const response = new Response('error', { status: 400 });
    await handleResponse(response, null);

    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.id).toBeNull();
  });

  test('200 JSON response is forwarded', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { data: 'hello' } });
    const response = new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    await handleResponse(response, 1);

    const output = (stdoutSpy.mock.calls[0][0] as string).trim();
    expect(JSON.parse(output)).toEqual({ jsonrpc: '2.0', id: 1, result: { data: 'hello' } });
  });

  test('200 non-JSON response is dropped with warning', async () => {
    const response = new Response('<html>not json</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });

    await handleResponse(response, 1);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping non-JSON response body'),
    );
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test('200 SSE stream forwards JSON data lines', async () => {
    const sseBody =
      'data: {"jsonrpc":"2.0","id":1,"result":"chunk1"}\n\ndata: {"jsonrpc":"2.0","id":1,"result":"chunk2"}\n\n';
    const response = new Response(sseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    await handleResponse(response, 1);

    expect(stdoutSpy).toHaveBeenCalledTimes(2);
    const out1 = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    const out2 = JSON.parse((stdoutSpy.mock.calls[1][0] as string).trim());
    expect(out1.result).toBe('chunk1');
    expect(out2.result).toBe('chunk2');
  });

  test('SSE non-JSON data lines are dropped with warning', async () => {
    const sseBody = 'data: not-json-at-all\ndata: {"valid":"json"}\n';
    const response = new Response(sseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    await handleResponse(response, 1);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('dropping non-JSON SSE data'),
    );
    // Only the valid JSON line should be forwarded
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim())).toEqual({
      valid: 'json',
    });
  });

  test('SSE buffer overflow aborts and emits error', async () => {
    // Create a response body that exceeds MAX_SSE_BUFFER_BYTES without newlines
    const bigChunk = 'x'.repeat(MAX_SSE_BUFFER_BYTES + 100);
    const response = new Response(bigChunk, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    await handleResponse(response, 7);

    expect(stderrSpy).toHaveBeenCalledWith(
      'mcp-sigv4-proxy: SSE buffer exceeded 1 MB limit, aborting stream\n',
    );
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.id).toBe(7);
    expect(output.error.message).toBe('SSE stream exceeded buffer limit');
  });

  test('SSE ignores non-data lines', async () => {
    const sseBody = 'event: message\nid: 123\ndata: {"ok":true}\nretry: 5000\n\n';
    const response = new Response(sseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });

    await handleResponse(response, 1);

    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim())).toEqual({ ok: true });
  });
});

describe('MAX_SSE_BUFFER_BYTES', () => {
  test('is 1 MB', () => {
    expect(MAX_SSE_BUFFER_BYTES).toBe(1_048_576);
  });
});

// --- Unit tests: validateEnv ---

describe('validateEnv', () => {
  let exitSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;
  const origEnv = { ...process.env };

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    process.env = { ...origEnv };
  });

  test('exits if MCP_SERVER_URL is missing', () => {
    delete process.env.MCP_SERVER_URL;
    expect(() => validateEnv()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith('mcp-sigv4-proxy: MCP_SERVER_URL is required\n');
  });

  test('exits if NODE_TLS_REJECT_UNAUTHORIZED=0', () => {
    process.env.MCP_SERVER_URL = 'https://example.com';
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    expect(() => validateEnv()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed'),
    );
  });

  test('exits if URL is not https', () => {
    process.env.MCP_SERVER_URL = 'http://example.com';
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    expect(() => validateEnv()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('must use https://'),
    );
  });

  test('exits for file:// URL', () => {
    process.env.MCP_SERVER_URL = 'file:///etc/passwd';
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    expect(() => validateEnv()).toThrow('process.exit called');
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('must use https://'),
    );
  });

  test('returns config for valid https URL', () => {
    process.env.MCP_SERVER_URL = 'https://example.com/path';
    process.env.AWS_REGION = 'eu-west-1';
    process.env.AWS_SERVICE = 'custom-service';
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const config = validateEnv();
    expect(config.url.hostname).toBe('example.com');
    expect(config.region).toBe('eu-west-1');
    expect(config.service).toBe('custom-service');
  });

  test('uses default region and service', () => {
    process.env.MCP_SERVER_URL = 'https://example.com';
    delete process.env.AWS_REGION;
    delete process.env.AWS_SERVICE;
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

    const config = validateEnv();
    expect(config.region).toBe('us-east-1');
    expect(config.service).toBe('bedrock-agentcore');
  });
});

// --- Unit tests: createSigner ---

describe('createSigner', () => {
  test('returns a SignatureV4 instance', () => {
    const config = {
      url: new URL('https://example.com'),
      region: 'us-east-1',
      service: 'bedrock-agentcore',
    };
    // Set credentials so fromNodeProviderChain can resolve
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

    const signer = createSigner(config);
    expect(signer).toBeDefined();
    expect(typeof signer.sign).toBe('function');
  });
});

// --- Unit tests: processLine ---

describe('processLine', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let stderrSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  test('skips empty lines', async () => {
    const url = new URL('https://example.com');
    const signer = createSigner({ url, region: 'us-east-1', service: 'test' });
    await processLine('', url, signer);
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test('skips non-JSON', async () => {
    const url = new URL('https://example.com');
    const signer = createSigner({ url, region: 'us-east-1', service: 'test' });
    await processLine('not json', url, signer);
    expect(stderrSpy).toHaveBeenCalledWith('mcp-sigv4-proxy: ignoring non-JSON input line\n');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test('skips non-JSON-RPC', async () => {
    const url = new URL('https://example.com');
    const signer = createSigner({ url, region: 'us-east-1', service: 'test' });
    await processLine('{"foo":"bar"}', url, signer);
    expect(stderrSpy).toHaveBeenCalledWith('mcp-sigv4-proxy: ignoring non-JSON-RPC message\n');
  });

  test('signs and forwards valid JSON-RPC, relays response', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

    const url = new URL('https://example.com/path');
    const signer = createSigner({ url, region: 'us-east-1', service: 'test' });

    const responseBody = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(responseBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      await processLine('{"jsonrpc":"2.0","method":"test","id":1}', url, signer);

      const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
      expect(output.jsonrpc).toBe('2.0');
      expect(output.id).toBe(1);
      expect(output.result).toBe('ok');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('emits JSON-RPC error on network failure', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

    const url = new URL('https://127.0.0.1:1');
    const signer = createSigner({ url, region: 'us-east-1', service: 'test' });
    await processLine('{"jsonrpc":"2.0","method":"test","id":99}', url, signer);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('request failed'));
    const output = JSON.parse((stdoutSpy.mock.calls[0][0] as string).trim());
    expect(output.id).toBe(99);
    expect(output.error.code).toBe(-32000);
    expect(output.error.message).toBe('Proxy request failed');
  });
});

// --- Integration tests (spawn compiled binary) ---

describe('integration: startup validation', () => {
  test('missing MCP_SERVER_URL exits with code 1', async () => {
    const result = await spawnProxy({ MCP_SERVER_URL: '' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('MCP_SERVER_URL is required');
  });

  test('http:// URL is rejected', async () => {
    const result = await spawnProxy({ MCP_SERVER_URL: 'http://example.com/foo' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must use https://');
  });

  test('file:// URL is rejected', async () => {
    const result = await spawnProxy({ MCP_SERVER_URL: 'file:///etc/passwd' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must use https://');
  });

  test('ftp:// URL is rejected', async () => {
    const result = await spawnProxy({ MCP_SERVER_URL: 'ftp://example.com' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must use https://');
  });

  test('NODE_TLS_REJECT_UNAUTHORIZED=0 is rejected', async () => {
    const result = await spawnProxy({
      MCP_SERVER_URL: 'https://example.com',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('NODE_TLS_REJECT_UNAUTHORIZED=0 is not allowed');
  });

  test('valid https:// URL starts and exits on stdin close', async () => {
    const result = await spawnProxy(baseEnv, { timeoutMs: 3000 });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('stdin closed');
  });
});

describe('integration: input validation', () => {
  test('empty lines are silently skipped', async () => {
    const result = await spawnProxy(baseEnv, { input: ['', '  ', ''], timeoutMs: 3000 });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('ignoring');
  });

  test('non-JSON input is ignored', async () => {
    const result = await spawnProxy(baseEnv, { input: ['not json'], timeoutMs: 3000 });
    expect(result.stderr).toContain('ignoring non-JSON input line');
    expect(result.stdout).toBe('');
  });

  test('JSON without jsonrpc is ignored', async () => {
    const result = await spawnProxy(baseEnv, { input: ['{"foo":"bar"}'], timeoutMs: 3000 });
    expect(result.stderr).toContain('ignoring non-JSON-RPC message');
  });
});

describe('integration: request forwarding', () => {
  test('network error produces JSON-RPC error with correct id', async () => {
    const result = await spawnProxy(
      { ...baseEnv, MCP_SERVER_URL: 'https://127.0.0.1:1' },
      { input: ['{"jsonrpc":"2.0","method":"test","id":42}'], timeoutMs: 5000 },
    );

    const output = JSON.parse(result.stdout.trim());
    expect(output.id).toBe(42);
    expect(output.error.code).toBe(-32000);
  });

  test('notification error has id: null', async () => {
    const result = await spawnProxy(
      { ...baseEnv, MCP_SERVER_URL: 'https://127.0.0.1:1' },
      {
        input: ['{"jsonrpc":"2.0","method":"notifications/initialized"}'],
        timeoutMs: 5000,
      },
    );

    const output = JSON.parse(result.stdout.trim());
    expect(output.id).toBeNull();
  });
});

describe('integration: sequential processing', () => {
  test('multiple rapid lines produce in-order responses', async () => {
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({ jsonrpc: '2.0', method: 'test', id: i + 1 }),
    );

    const result = await spawnProxy(
      { ...baseEnv, MCP_SERVER_URL: 'https://127.0.0.1:1' },
      { input: lines, timeoutMs: 15000 },
    );

    const outputs = result.stdout
      .trim()
      .split('\n')
      .filter((l) => l)
      .map((l) => JSON.parse(l));

    expect(outputs).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(outputs[i].id).toBe(i + 1);
    }
  });
});

describe('integration: graceful shutdown', () => {
  test('stdin close drains and exits 0', async () => {
    const result = await spawnProxy(baseEnv, { timeoutMs: 3000 });
    expect(result.stderr).toContain('stdin closed, draining in-flight requests');
    expect(result.code).toBe(0);
  });

  test('SIGTERM triggers shutdown', async () => {
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
      (resolve) => {
        const child = spawn('node', [BIN], {
          env: { ...process.env, ...baseEnv },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout!.on('data', (d) => (stdout += d.toString()));
        child.stderr!.on('data', (d) => (stderr += d.toString()));

        setTimeout(() => child.kill('SIGTERM'), 500);

        child.on('close', (code) => resolve({ stdout, stderr, code }));
      },
    );

    expect(result.stderr).toContain('received SIGTERM');
  });
});
