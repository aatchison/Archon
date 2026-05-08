import { spawn } from 'bun';
import type {
  IAgentProvider,
  SendQueryOptions,
  MessageChunk,
  ProviderCapabilities,
} from '../../types';
import { OPENCODE_CAPABILITIES } from './capabilities';
import { resolveOpenCodeBinaryPath } from './binary-resolver';
import { createLogger } from '@archon/paths';

const log = createLogger('provider.opencode');

/**
 * Build the CLI argument list for an opencode run invocation.
 * Exported for unit testing without spawning a real process.
 */
export function buildOpenCodeArgs(
  prompt: string,
  resumeSessionId?: string,
  options?: SendQueryOptions
): string[] {
  const args = ['run'];
  if (resumeSessionId) {
    args.push('--session', resumeSessionId);
  }
  if (options?.model) {
    args.push('--model', options.model);
  }
  args.push(prompt);
  return args;
}

export class OpenCodeProvider implements IAgentProvider {
  constructor(private readonly configBinaryPath?: string) {}

  getType(): string {
    return 'opencode';
  }

  getCapabilities(): ProviderCapabilities {
    return OPENCODE_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    // Fix #3: Honor abortSignal — throw immediately on pre-aborted entry.
    if (options?.abortSignal?.aborted) {
      throw new Error('Query aborted');
    }

    const args = buildOpenCodeArgs(prompt, resumeSessionId, options);

    const binaryPath = await resolveOpenCodeBinaryPath(this.configBinaryPath);

    log.info({ args, cwd }, 'opencode.query_started');

    const processEnv = globalThis.process?.env || {};
    const child = spawn([binaryPath, ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...processEnv, ...options?.env },
    });

    const stdout = child.stdout;

    // Fix #3: Propagate abort signal to the subprocess. Use { once: true } so
    // the listener auto-removes after firing and we don't need to track it.
    const onAbort = (): void => {
      child.kill();
    };
    options?.abortSignal?.addEventListener('abort', onAbort, { once: true });

    // Fix #1: Drain stderr concurrently with stdout. POSIX pipes will deadlock
    // the subprocess once the kernel pipe buffer (~64 KB) fills up if we never
    // read from stderr. Collect lines so we can surface them in the result chunk.
    const stderrLines: string[] = [];
    const stderrDone = (async (): Promise<void> => {
      for await (const chunk of child.stderr) {
        const text = new TextDecoder().decode(chunk).trim();
        if (text) {
          stderrLines.push(text);
        }
      }
    })();

    try {
      for await (const chunk of stdout) {
        const text = new TextDecoder().decode(chunk).trim();
        if (text) {
          yield { type: 'assistant', content: text };
        }
      }

      // Wait for stderr drain to complete before reading stderrLines.
      await stderrDone;

      // Fix #2: Wait for the child process to exit and capture the exit code.
      const exitCode = await child.exited;

      // Fix #4: Pair opencode.query_started with _completed or _failed.
      if (exitCode === 0) {
        log.info({ exitCode }, 'opencode.query_completed');
      } else {
        log.warn({ exitCode, stderr: stderrLines }, 'opencode.query_failed');
      }

      // Fix #2: Emit a terminal result chunk so callers (dag-executor, orchestrator)
      // can detect errors and surface them — matching the Claude/Codex contract.
      yield {
        type: 'result',
        isError: exitCode !== 0,
        errors: exitCode !== 0 ? stderrLines : undefined,
        sessionId: resumeSessionId,
        stopReason: exitCode === 0 ? 'completed' : 'error',
      };
    } finally {
      // Remove abort listener if it hasn't fired (no-op when { once: true } already fired).
      options?.abortSignal?.removeEventListener('abort', onAbort);

      if (child.exitCode === null) {
        child.kill();
      }
    }
  }
}
