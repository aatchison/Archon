/**
 * OpenCode binary resolver for compiled (bun --compile) archon binaries.
 *
 * OpenCode wraps a third-party CLI (`opencode`) that must exist on the host
 * machine. In dev mode the path can be resolved from a well-known location;
 * in compiled binaries the build-host path is frozen and cannot be used.
 *
 * Resolution order:
 * 1. `OPENCODE_BIN_PATH` environment variable — honored in both modes.
 *    If set but the file doesn't exist, throws with a clear message.
 * 2. `assistants.opencode.opencodeBinaryPath` in config (optional param).
 *    If set but the file doesn't exist, throws with a clear message.
 * 3. Autodetect at `~/.opencode/bin/opencode` (POSIX default install location).
 * 4. Throw with install instructions.
 */
import { existsSync as _existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@archon/paths';

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

/** Lazy-initialized logger */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('opencode-binary');
  return cachedLog;
}

const INSTALL_INSTRUCTIONS =
  'opencode binary not found. Install via the opencode docs (https://opencode.ai/) and\n' +
  'either set OPENCODE_BIN_PATH or pass assistants.opencode.opencodeBinaryPath in\n' +
  '.archon/config.yaml.\n\n' +
  'Example config.yaml entry:\n' +
  '    assistants:\n' +
  '      opencode:\n' +
  '        opencodeBinaryPath: /absolute/path/to/opencode\n\n' +
  'Or via environment variable:\n' +
  '    export OPENCODE_BIN_PATH="$HOME/.opencode/bin/opencode"\n\n' +
  'See: https://opencode.ai/';

/**
 * Resolve the path to the OpenCode CLI binary.
 *
 * Resolution order: env var → config override → autodetect → throw.
 *
 * @param configOpenCodeBinaryPath - Optional path from
 *   `assistants.opencode.opencodeBinaryPath` in .archon/config.yaml.
 */
export async function resolveOpenCodeBinaryPath(
  configOpenCodeBinaryPath?: string
): Promise<string> {
  // 1. Environment variable override — honored in both dev and binary mode.
  const envPath = process.env.OPENCODE_BIN_PATH;
  if (envPath) {
    if (!fileExists(envPath)) {
      throw new Error(
        `OPENCODE_BIN_PATH is set to "${envPath}" but the file does not exist.\n` +
          'Please verify the path points to the OpenCode CLI binary.'
      );
    }
    getLog().info({ binaryPath: envPath, source: 'env' }, 'opencode.binary_resolved');
    return envPath;
  }

  // 2. Config file override
  if (configOpenCodeBinaryPath) {
    if (!fileExists(configOpenCodeBinaryPath)) {
      throw new Error(
        `assistants.opencode.opencodeBinaryPath is set to "${configOpenCodeBinaryPath}" but the file does not exist.\n` +
          'Please verify the path in .archon/config.yaml points to the OpenCode CLI binary.'
      );
    }
    getLog().info(
      { binaryPath: configOpenCodeBinaryPath, source: 'config' },
      'opencode.binary_resolved'
    );
    return configOpenCodeBinaryPath;
  }

  // 3. Autodetect — the standard opencode install location on POSIX.
  //    Windows is not a primary target for opencode; skip for now.
  const autodetectPath =
    process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? homedir(), 'opencode', 'bin', 'opencode.exe')
      : join(homedir(), '.opencode', 'bin', 'opencode');

  if (fileExists(autodetectPath)) {
    getLog().info({ binaryPath: autodetectPath, source: 'autodetect' }, 'opencode.binary_resolved');
    return autodetectPath;
  }

  // 4. Not found — throw with install instructions
  throw new Error(INSTALL_INSTRUCTIONS);
}
