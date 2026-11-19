// Test only: the hooks module of a throwaway plugin tests/e2e/compare.mjs builds in a temporary folder and loads ahead of the plugin in
// its rowless pass. It keeps from the plugin what Claude Code's built-in security default keeps from a plugin in the `user` tier in
// Team and Enterprise organizations, which a session on an API key never seats: every collector row, and the session's identity
// (`$.session.identity()`). A plugin cannot send a row on past the plugins after it as the security default does (`next.to` is for
// managed plugins), so it answers each row itself: the exporter beneath gets none either, and the comparison counts the plugin's rows
// against another pass's.
//
// It is not a plugin in this repository: a second `.claude-plugin/plugin.json` anywhere in it fails org sync's validation, which takes
// the repository root as the one plugin (scripts/check-layout.sh).

import type { Register } from 'claude-code'

export const register: Register = on => {
  on('telemetry.log', { to: 'collector' }, async () => ({ value: undefined }))
  on('session.identity', async ($, e, next) => (next.origin.plugin === 'mainwave' ? { value: { deny: 'the end-to-end test keeps the identity from mainwave, as the security default does' } } : next(e)))
}
