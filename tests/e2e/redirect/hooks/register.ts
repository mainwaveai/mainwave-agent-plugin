// Test only, loaded by tests/e2e/compare.mjs beside the plugin: a request to Mainwave's dev collector goes to the local receiver named
// by MW_E2E_RECEIVER instead, path and all, so the comparison sees exactly what the plugin would have sent. Anything else goes on.

import type { Register } from 'claude-code'

const DEV = 'https://collector.dev.mainwave.com'

export const register: Register = on => {
  on('http.fetch', async ($, e, next) => {
    if (!e.url.startsWith(`${DEV}/`)) return next(e)
    const receiver = await $.env.get('MW_E2E_RECEIVER')
    if (!receiver) return { deny: 'MW_E2E_RECEIVER is not set' }
    return next({ ...e, url: `${receiver}${e.url.slice(DEV.length)}` })
  })
}
