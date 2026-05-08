import { isRegisteredProvider, registerProvider } from '../../registry';

import { OPENCODE_CAPABILITIES } from './capabilities';
import { OpenCodeProvider } from './provider';

/**
 * Register the OpenCode community provider.
 *
 * Idempotent — safe to call multiple times, so process entrypoints (CLI,
 * server, config-loader) can each call it without coordination. Kept
 * separate from `registerBuiltinProviders()` because `builtIn: false` is
 * load-bearing: OpenCode wraps a third-party CLI and belongs under
 * community/ per the Phase 2 contract (#1195).
 */
export function registerOpenCodeProvider(): void {
  if (isRegisteredProvider('opencode')) return;
  registerProvider({
    id: 'opencode',
    displayName: 'OpenCode (community)',
    factory: () => new OpenCodeProvider(),
    capabilities: OPENCODE_CAPABILITIES,
    builtIn: false,
  });
}
