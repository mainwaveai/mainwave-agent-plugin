// Test only: the hooks module of a throwaway plugin tests/e2e/compare.mjs builds in a temporary folder and loads ahead of the plugin in
// its rowless pass. It keeps every collector row from the plugin, as Claude Code's built-in security default does for a plugin in the
// `user` tier in Team and Enterprise organizations, which a session on an API key never seats. A plugin cannot send a row on past the
// plugins after it as the security default does (`next.to` is for managed plugins), so it answers each row itself: the exporter
// beneath gets none either, and the comparison counts the plugin's rows against another pass's, the same scripted session.
//
// It is not a plugin in this repository: a second `.claude-plugin/plugin.json` anywhere in it fails org sync's validation, which takes
// the repository root as the one plugin (scripts/check-layout.sh).

import type { Register } from 'claude-code'

export const register: Register = on => {
  on('telemetry.log', { to: 'collector' }, async () => ({ value: undefined }))
}
