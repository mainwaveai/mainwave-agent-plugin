// Test only: the hooks module of a throwaway plugin tests/e2e/compare.mjs builds in a temporary folder and loads beside the plugin. A
// request to Mainwave's dev collector, or to the API beside it (where the plugin reads its organization's settings), goes to the local
// receiver named by MW_E2E_RECEIVER instead, path and all, so the comparison sees exactly what the plugin would have sent. Anything
// else goes on.
//
// It is not a plugin in this repository: a second `.claude-plugin/plugin.json` anywhere in it fails org sync's validation, which takes
// the repository root as the one plugin (scripts/check-layout.sh).

import type { Register } from 'claude-code'

const DEV = ['https://collector.dev.mainwave.com', 'https://api.dev.mainwave.com']

export const register: Register = on => {
  on('http.fetch', async ($, e, next) => {
    const origin = DEV.find(o => e.url.startsWith(`${o}/`))
    if (origin === undefined) return next(e)
    const receiver = await $.env.get('MW_E2E_RECEIVER')
    if (!receiver) return { deny: 'MW_E2E_RECEIVER is not set' }
    return next({ ...e, url: `${receiver}${e.url.slice(origin.length)}` })
  })
}
