export const OPENCODE_CAPABILITIES = {
  sessionResume: true,
  mcp: false, // not forwarded to opencode CLI; flip when --mcp flag is wired through
  hooks: false, // OpenCode doesn't support SDK-style hooks yet
  skills: false, // not forwarded to opencode CLI; flip when supported
  agents: false, // not forwarded to opencode CLI; flip when supported
  toolRestrictions: false, // not forwarded to opencode CLI; flip when supported
  structuredOutput: false, // not forwarded to opencode CLI; flip when supported
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false, // not forwarded to opencode CLI; flip when supported
  fallbackModel: false,
  sandbox: false,
};
