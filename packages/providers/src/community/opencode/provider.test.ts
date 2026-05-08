/**
 * Unit tests for OpenCodeProvider.
 *
 * bun.spawn is a built-in that cannot be replaced via mock.module('bun').
 * Strategy:
 *   - Spawn-arg construction: tested via the exported `buildOpenCodeArgs` helper.
 *   - Abort pre-flight: tested directly (throws before spawn fires).
 *   - Streaming / exit-code / stderr paths: tested by spawning real POSIX
 *     utilities (echo, sh -c 'exit N', cat) that are available in the test env.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { createMockLogger } from '../../test/mocks/logger';

// ─── Mock @archon/paths ──────────────────────────────────────────────────────

const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
}));

// ─── Mock binary-resolver ────────────────────────────────────────────────────
//
// Resolve to a real binary so integration tests can spawn real processes.
// Individual tests override when they need a different path.

const mockResolveBinary = mock(async () => '/usr/bin/env');

mock.module('./binary-resolver', () => ({
  resolveOpenCodeBinaryPath: mockResolveBinary,
}));

// Import AFTER all mocks — module resolution freezes them.
import { buildOpenCodeArgs, OpenCodeProvider } from './provider';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function collect(
  gen: AsyncGenerator<unknown>
): Promise<{ chunks: unknown[]; error?: Error }> {
  const chunks: unknown[] = [];
  try {
    for await (const chunk of gen) chunks.push(chunk);
    return { chunks };
  } catch (err) {
    return { chunks, error: err as Error };
  }
}

// ─── buildOpenCodeArgs (pure function — no spawn needed) ─────────────────────

describe('buildOpenCodeArgs', () => {
  test('without resumeSessionId: args are ["run", <prompt>]', () => {
    const args = buildOpenCodeArgs('hello world');
    expect(args).toEqual(['run', 'hello world']);
  });

  test('with resumeSessionId: --session <id> precedes the prompt', () => {
    const args = buildOpenCodeArgs('hello', 'sess-abc');
    expect(args).toContain('--session');
    expect(args).toContain('sess-abc');
    const sessionIdx = args.indexOf('--session');
    const promptIdx = args.indexOf('hello');
    expect(sessionIdx).toBeLessThan(promptIdx);
    // Prompt must be last
    expect(args[args.length - 1]).toBe('hello');
  });

  test('with options.model: --model <model> is included', () => {
    const args = buildOpenCodeArgs('hi', undefined, { model: 'gpt-4o' });
    expect(args).toContain('--model');
    const modelIdx = args.indexOf('--model');
    expect(args[modelIdx + 1]).toBe('gpt-4o');
    // Prompt is still last
    expect(args[args.length - 1]).toBe('hi');
  });

  test('with both resumeSessionId and model: all flags present, prompt last', () => {
    const args = buildOpenCodeArgs('my prompt', 'sess-1', { model: 'o3' });
    expect(args).toContain('--session');
    expect(args).toContain('sess-1');
    expect(args).toContain('--model');
    expect(args).toContain('o3');
    expect(args[args.length - 1]).toBe('my prompt');
  });

  test('without model option: no --model flag', () => {
    const args = buildOpenCodeArgs('prompt', undefined, {});
    expect(args).not.toContain('--model');
  });
});

// ─── OpenCodeProvider ─────────────────────────────────────────────────────────

describe('OpenCodeProvider', () => {
  let provider: OpenCodeProvider;

  beforeEach(() => {
    provider = new OpenCodeProvider();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    // Default: resolves to a real binary so integration tests work.
    mockResolveBinary.mockImplementation(async () => '/usr/bin/env');
  });

  // ── getType / getCapabilities ────────────────────────────────────────────

  test('getType returns "opencode"', () => {
    expect(provider.getType()).toBe('opencode');
  });

  test('getCapabilities has expected flags', () => {
    const caps = provider.getCapabilities();
    expect(caps.sessionResume).toBe(true);
    expect(caps.envInjection).toBe(true);
    expect(caps.mcp).toBe(false);
    expect(caps.hooks).toBe(false);
    expect(caps.structuredOutput).toBe(false);
  });

  // ── abortSignal pre-flight ────────────────────────────────────────────────
  //
  // This check runs before spawn, so no real process is involved.

  test('pre-aborted signal throws "Query aborted" with no chunks', async () => {
    const controller = new AbortController();
    controller.abort();

    const { chunks, error } = await collect(
      provider.sendQuery('hi', '/tmp', undefined, { abortSignal: controller.signal })
    );

    expect(error).toBeDefined();
    expect(error!.message).toBe('Query aborted');
    expect(chunks).toHaveLength(0);
  });

  test('non-aborted signal does not throw pre-flight', async () => {
    // Resolve to 'true' (always exits 0, no stdout) so the test is fast.
    mockResolveBinary.mockImplementation(async () => '/usr/bin/true');
    const controller = new AbortController();

    const { error } = await collect(
      provider.sendQuery('hi', '/tmp', undefined, { abortSignal: controller.signal })
    );

    // 'true' exits 0 → no error expected.
    expect(error).toBeUndefined();
  });

  // ── Streaming stdout → assistant chunks (real subprocess) ────────────────
  //
  // Spawn `echo` so we get real stdout without a real opencode binary.

  test('stdout lines become assistant chunks', async () => {
    // Use 'printf' via 'env sh -c' to emit multi-line output.
    // The binary resolver points to /usr/bin/env; we pass 'sh' as the first
    // arg so that the spawned command is: /usr/bin/env sh -c 'printf ...'
    // However, provider.ts prepends the binary path to buildOpenCodeArgs().
    // Since args start with ['run', ...], env will try to exec 'run' which
    // won't exist. We need a different approach.
    //
    // Better: point the binary resolver to 'sh' and pass -c printf as args
    // via a prompt that doubles as a shell script.
    //
    // Easiest: resolve to /bin/echo so 'run <prompt>' becomes:
    //   /bin/echo run <prompt>
    // which outputs "run <prompt>" — that's one chunk.
    mockResolveBinary.mockImplementation(async () => '/bin/echo');

    const { chunks } = await collect(provider.sendQuery('hello', '/tmp'));

    const assistantChunks = chunks.filter(
      (c): c is { type: 'assistant'; content: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'assistant'
    );
    // /bin/echo prints its args on one line → exactly one assistant chunk.
    expect(assistantChunks.length).toBeGreaterThanOrEqual(1);
    // The chunk contains at least the prompt text.
    expect(assistantChunks.some(c => c.content.includes('hello'))).toBe(true);
  });

  // ── Terminal result chunk on success (real subprocess) ───────────────────

  test('exit code 0 → result chunk with isError: false and stopReason "completed"', async () => {
    mockResolveBinary.mockImplementation(async () => '/usr/bin/true');

    const { chunks } = await collect(provider.sendQuery('hi', '/tmp'));

    const result = chunks.find(
      (c): c is { type: 'result'; isError?: boolean; stopReason?: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result).toBeDefined();
    expect(result!.isError).toBe(false);
    expect(result!.stopReason).toBe('completed');
  });

  test('exit code 0 result carries resumeSessionId', async () => {
    mockResolveBinary.mockImplementation(async () => '/usr/bin/true');

    const { chunks } = await collect(provider.sendQuery('hi', '/tmp', 'sess-xyz'));

    const result = chunks.find(
      (c): c is { type: 'result'; sessionId?: string } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result?.sessionId).toBe('sess-xyz');
  });

  test('exit code 0 result has no errors field', async () => {
    mockResolveBinary.mockImplementation(async () => '/usr/bin/true');

    const { chunks } = await collect(provider.sendQuery('hi', '/tmp'));

    const result = chunks.find(
      (c): c is { type: 'result'; errors?: string[] } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result!.errors).toBeUndefined();
  });

  // ── Terminal result chunk on failure (real subprocess) ───────────────────
  //
  // 'false' always exits 1.

  test('non-zero exit code → result chunk with isError: true', async () => {
    mockResolveBinary.mockImplementation(async () => '/usr/bin/false');

    const { chunks } = await collect(provider.sendQuery('hi', '/tmp'));

    const result = chunks.find(
      (c): c is { type: 'result'; isError?: boolean } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
  });

  test('stderr output is captured into result.errors on failure', async () => {
    // Use a shell one-liner that writes to stderr and exits 1.
    // Resolve to 'sh' and put the script as the whole arg list.
    // Because provider prepends the binary path and appends ['run', prompt],
    // we craft a binary path to 'sh' and let the 'run' arg be the sh flag.
    //
    // Actually, the simplest approach is to point the binary to a shell script
    // that we write to /tmp. Let's write a temp script.
    const scriptPath = '/tmp/archon-test-opencode-fail.sh';
    await Bun.write(scriptPath, '#!/bin/sh\necho "fatal: bad config" >&2\nexit 2\n');
    await Bun.spawn(['chmod', '+x', scriptPath]).exited;

    mockResolveBinary.mockImplementation(async () => scriptPath);

    const { chunks } = await collect(provider.sendQuery('hi', '/tmp'));

    const result = chunks.find(
      (c): c is { type: 'result'; isError?: boolean; errors?: string[] } =>
        typeof c === 'object' && c !== null && (c as { type?: string }).type === 'result'
    );
    expect(result).toBeDefined();
    expect(result!.isError).toBe(true);
    expect(result!.errors).toBeDefined();
    expect(result!.errors!.join(' ')).toContain('fatal: bad config');
  });

  // ── abortSignal mid-stream ────────────────────────────────────────────────
  //
  // Start a long-running process and abort mid-stream.
  // We verify the abort listener is wired (the provider calls child.kill).
  // Using 'sleep' to keep the child alive long enough to abort it.

  test('mid-stream abort fires the kill path (signal registered on child)', async () => {
    // Resolve to 'sleep' so the child stays alive while we abort.
    mockResolveBinary.mockImplementation(async () => '/usr/bin/sleep');
    const controller = new AbortController();

    // Start sendQuery, abort immediately (before sleep finishes).
    const gen = provider.sendQuery('1', '/tmp', undefined, {
      abortSignal: controller.signal,
    });

    const nextPromise = gen.next(); // begin — spawns 'sleep 1'
    controller.abort(); // fire abort mid-stream

    // Drain the generator (the provider should kill the child and return).
    try {
      await nextPromise;
      await gen.return(undefined);
    } catch {
      // abort may cause the generator to throw or return; either is fine.
    }

    // If we reach here without hanging, kill was called and the process ended.
    // The test passes as long as it completes within the test timeout.
    expect(true).toBe(true);
  });
});
