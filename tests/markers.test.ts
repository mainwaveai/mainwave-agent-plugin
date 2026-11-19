// The markers' reading, pure: which commands made a commit, opened a pull or merge request, which tool saved a ticket, what the account
// record says of the plan, and whether the CLI's hooks send these already. The cases follow what Mainwave's CLI hooks read, so the
// plugin's markers are the same spans.

import { describe, expect, test } from 'claude-code/testing'

import { classifyGlab, glabConfigDir, glabHosts, glabTexts, mrAttributes, mrFromApi, mrUrlOf, parseApiCall, repositoryIdOf, sameUrl, shellSegments, stripDraft } from '../hooks/glab.ts'
import {
  apiErrorIn, cliCanSend, cliHookKinds, cliScriptOf, commitAttributes, commitsInOutput, errorTypeOf, gitCommits, isPrCreate, JIRA_TOOL, jiraTicket, LINEAR_TOOL, linearTicket, markerResource, MAX_FILES, outputTexts,
  parseNumstat, parsePrStats, placeAttributes, prAttributes, prCreateOf, prLookup, prNumberOf, prUrlOf, ticketSpan,
} from '../hooks/markers.ts'
import { limitKeySegment, snapshotOf, snapshotOfText } from '../hooks/snapshot.ts'

const SHA = 'a'.repeat(40)
const PARENT = 'b'.repeat(40)

describe('commits', () => {
  test('a git commit at a command position, with the folders its -C options name; not commit-tree, not a quoted mention', () => {
    expect(gitCommits('git commit -m "x"')).toEqual([{}])
    expect(gitCommits('cd app && git -C sub commit -am wip')).toEqual([{ dir: 'sub' }])
    expect(gitCommits('git -C /repo -C pkg commit -m x')).toEqual([{ dir: '/repo/pkg' }])
    expect(gitCommits('GIT_AUTHOR_NAME=me git commit -m x; git commit --amend')).toEqual([{}, {}])
    expect(gitCommits('git commit-tree HEAD^{tree}')).toEqual([])
    expect(gitCommits('echo "please git commit"')).toEqual([])
    expect(gitCommits(undefined)).toEqual([])
  })

  test('the commits a result reports, each once, from stdout and stderr; none for a failed or quiet commit', () => {
    const texts = outputTexts({ stdout: '[main 1a2b3c4] fix\n 1 file changed\n[main (root-commit) 9f8e7d6] init\n', stderr: '[main 1a2b3c4] fix\n' })
    expect(commitsInOutput(texts)).toEqual(['1a2b3c4', '9f8e7d6'])
    expect(commitsInOutput(outputTexts({ stdout: 'nothing to commit, working tree clean', stderr: '' }))).toEqual([])
    expect(commitsInOutput(outputTexts('[detached HEAD abcdef0] wip'))).toEqual(['abcdef0'])
  })

  test("git show's numstat: totals, a rename's new path, a binary file counted with 0 lines and flagged", () => {
    const out = `${SHA}\n${PARENT}\0\n3\t1\tsrc/a.ts\0-\t-\tlogo.png\x002\t0\t\0old.ts\0new.ts\0`
    const c = parseNumstat(out)!
    expect(c).toEqual({
      sha: SHA, parents: [PARENT],
      files: [
        { path: 'src/a.ts', linesAdded: 3, linesRemoved: 1, isBinary: false },
        { path: 'logo.png', linesAdded: 0, linesRemoved: 0, isBinary: true },
        { path: 'new.ts', linesAdded: 2, linesRemoved: 0, isBinary: false },
      ],
    })
    expect(commitAttributes(c)).toEqual({
      'vcs.commit.sha': SHA, 'vcs.commit.parent_sha': PARENT, 'vcs.commit.parent_count': 1, 'vcs.commit.files_changed': 3, 'vcs.commit.lines_added': 5, 'vcs.commit.lines_removed': 1,
      'vcs.commit.file.paths': ['src/a.ts', 'logo.png', 'new.ts'], 'vcs.commit.file.lines_added': [3, 0, 2], 'vcs.commit.file.lines_removed': [1, 0, 0], 'vcs.commit.file.is_binary': [false, true, false],
    })
  })

  test('a root commit has no parent; output that does not parse is no commit', () => {
    const root = parseNumstat(`${SHA}\n\0\n1\t0\tREADME.md\0`)!
    expect(commitAttributes(root)['vcs.commit.parent_sha']).toBeUndefined()
    expect(commitAttributes(root)['vcs.commit.parent_count']).toBe(0)
    expect(parseNumstat('fatal: bad object')).toBeUndefined()
    expect(parseNumstat(`${SHA}\n\0x\ty\tz\0`)).toBeUndefined()
  })

  test('past the cap the per-file lists stop; the totals cover every file', () => {
    const files = Array.from({ length: MAX_FILES + 5 }, (_, i) => ({ path: `f${i}`, linesAdded: 1, linesRemoved: 0, isBinary: false }))
    const a = commitAttributes({ sha: SHA, parents: [], files })
    expect(a['vcs.commit.files_changed']).toBe(MAX_FILES + 5)
    expect(a['vcs.commit.lines_added']).toBe(MAX_FILES + 5)
    expect((a['vcs.commit.file.paths'] as readonly string[]).length).toBe(MAX_FILES)
  })
})

describe('GitHub pull requests', () => {
  test('gh pr create at a command position, its address, number and quoted title; its size from gh pr view', () => {
    expect(isPrCreate('git push && gh pr create --title "Fix login" --body x')).toBe(true)
    expect(isPrCreate('git commit -m "then gh pr create"')).toBe(false)
    const url = prUrlOf(['Creating pull request for feat into main\n\nhttps://github.com/acme/api/pull/42\n'])!
    expect([url, prNumberOf(url)]).toEqual(['https://github.com/acme/api/pull/42', '42'])
    expect(prCreateOf('gh pr create --title "Fix login" --body x')).toEqual({ title: 'Fix login' })
    expect(prCreateOf("GH_HOST=github.com gh pr create --title='Fix it'")).toEqual({ title: 'Fix it' })
    expect(prCreateOf('gh pr create -t Fix --fill')).toEqual({ title: 'Fix' })
    // A title the shell expands is not the title.
    expect(prCreateOf('gh pr create --title "$TITLE"')).toEqual({})
    expect(prCreateOf('gh pr create --title "$(git log -1 --format=%s)"')).toEqual({})
    expect(prCreateOf('echo "gh pr create"')).toBeUndefined()
    // Behind a wrapper word, as in an if or a loop.
    expect(prCreateOf('if git push; then gh pr create --title x --fill; fi')).toEqual({ title: 'x' })
    expect(prCreateOf('env GH_TOKEN=t gh pr create -t y')).toEqual({ title: 'y' })
    // Its size is looked up by its address, so in its own repository wherever the command ran.
    expect(prLookup(url)).toEqual(['gh', 'pr', 'view', url, '--json', 'changedFiles,additions,deletions'])
    // One that already exists was not opened, whatever the command's exit.
    expect(prUrlOf(['a pull request for branch "feat" into branch "main" already exists:\nhttps://github.com/acme/api/pull/12\n'])).toBeUndefined()
    // Another command of the chain saying something else exists is not gh's.
    expect(prUrlOf(["fatal: a branch named 'feat' already exists\nhttps://github.com/acme/api/pull/13\n"])).toBe('https://github.com/acme/api/pull/13')
    expect(parsePrStats('{"changedFiles":3,"additions":10,"deletions":2}')).toEqual({ changedFiles: 3, additions: 10, deletions: 2 })
    expect(parsePrStats('not json')).toEqual({})
    expect(prAttributes(url, '42', 'Fix login', { changedFiles: 3 })).toEqual({
      'vcs.repository.url.full': url, 'vcs.change.id': '42', 'vcs.provider.name': 'github', 'vcs.change.title': 'Fix login', 'vcs.change.files_changed': 3,
    })
    expect(prUrlOf(['a --web create opens the browser'])).toBeUndefined()
  })
})

describe('GitLab merge requests', () => {
  test('glab mr create and a POST of glab api to merge_requests; not a GET, not the words in a string', () => {
    expect(classifyGlab('GITLAB_HOST=git.example.com glab mr create -t "Fix it" --fill')).toEqual({ kind: 'create', title: 'Fix it' })
    expect(classifyGlab('glab api projects/12/merge_requests -f title=Hi -f source_branch=x')).toEqual({ kind: 'api', title: 'Hi' })
    expect(classifyGlab('glab api projects/12/merge_requests')).toBeUndefined()
    expect(classifyGlab('glab mr view 3')).toBeUndefined()
    expect(classifyGlab('git commit -m "glab mr create"')).toBeUndefined()
    expect(parseApiCall(['-X', 'post', 'projects/1/merge_requests'])).toEqual({ endpoint: 'projects/1/merge_requests', method: 'POST' })
    expect(shellSegments('a "b;c" | d')).toEqual([['a', 'b;c'], ['d']])
  })

  test("the request glab printed after its Creating line, for that project; never git push's remote line", () => {
    const err = 'Creating merge request for feat into main in acme/api\n'
    const out = 'remote: View merge request https://gitlab.example.com/acme/api/-/merge_requests/9\nhttps://gitlab.example.com/acme/api/-/merge_requests/7\n'
    const texts = glabTexts({ stdout: out, stderr: err })
    expect(mrUrlOf(texts[0])).toEqual({ url: 'https://gitlab.example.com/acme/api/-/merge_requests/7', iid: '7', projectUrl: 'https://gitlab.example.com/acme/api' })
    expect(mrUrlOf('see https://gitlab.example.com/a/b/-/merge_requests/1 and https://gitlab.example.com/a/b/-/merge_requests/2')).toBeUndefined()
    expect(mrFromApi('{"iid":5,"project_id":77,"title":"Draft: x","web_url":"https://gitlab.com/a/b/-/merge_requests/5","changes_count":"1000+"}')).toEqual({
      iid: 5, projectId: 77, title: 'Draft: x', webUrl: 'https://gitlab.com/a/b/-/merge_requests/5',
    })
  })

  test("the hosts glab is set up for, the project's ID by instance, the draft marker gone", () => {
    expect([...glabHosts('git_protocol: ssh\nhosts:\n    gitlab.example.com:\n        token: secret\n    "lab.example.com:8443":\n        api_protocol: https\nother: 1\n')].sort()).toEqual(['gitlab.com', 'gitlab.example.com', 'lab.example.com:8443'])
    expect(glabConfigDir('/home/me', 'macos', false)).toBe('/home/me/Library/Application Support/glab-cli')
    expect(glabConfigDir('/home/me', 'macos', true)).toBe('/home/me/.config/glab-cli')
    expect(repositoryIdOf('https://GitLab.example.com:443/a/b/-/merge_requests/1', 12)).toBe('gitlab.example.com:12')
    expect(repositoryIdOf('https://gitlab.example.com/a/b/-/merge_requests/1', undefined)).toBeUndefined()
    expect(stripDraft('[Draft] Draft: Fix')).toBe('Fix')
    expect(sameUrl('https://gitlab.com/a/b/-/merge_requests/1/', 'https://gitlab.com/a/b/-/merge_requests/1')).toBe(true)
    expect(mrAttributes({ url: 'https://gitlab.com/a/b/-/merge_requests/1', iid: '1', projectUrl: 'https://gitlab.com/a/b' }, 'gitlab.com:12', 'Fix', 4)).toEqual({
      'vcs.repository.url.full': 'https://gitlab.com/a/b/-/merge_requests/1', 'vcs.change.id': '1', 'vcs.provider.name': 'gitlab', 'vcs.repository.id': 'gitlab.com:12', 'vcs.change.title': 'Fix', 'vcs.change.files_changed': 4,
    })
  })
})

describe('tickets', () => {
  test("the managed hooks' tool patterns", () => {
    expect(LINEAR_TOOL.test('mcp__linear-server__save_issue')).toBe(true)
    expect(LINEAR_TOOL.test('mcp__claude_ai_Linear__save_issue')).toBe(true)
    expect(LINEAR_TOOL.test('mcp__linear__list_issues')).toBe(false)
    expect(JIRA_TOOL.test('mcp__claude_ai_Atlassian__createJiraIssue')).toBe(true)
    expect(JIRA_TOOL.test('mcp__atlassian__getJiraIssue')).toBe(false)
  })

  test("a Linear save: the key from the result's own fields, never its description; created unless the call named an issue", () => {
    const result = [{ type: 'text', text: JSON.stringify({ id: 'ENG-12', url: 'https://linear.app/acme/issue/ENG-12/fix', teamId: 'team-uuid', description: 'see ENG-1' }) }]
    const created = linearTicket('mcp__linear__save_issue', { title: 'x' }, result)!
    // The address up to the key: the slug after it is the ticket's title.
    expect(created).toEqual({ 'work.item.id': 'ENG-12', 'work.item.op': 'created', 'work.item.url': 'https://linear.app/acme/issue/ENG-12', 'work.vendor': 'linear', 'work.instance': 'team-uuid' })
    expect(ticketSpan(created)).toBe('work.item.created')
    expect(linearTicket('mcp__linear__save_issue', { id: 'ENG-12' }, result)!['work.item.op']).toBe('updated')
    expect(linearTicket('mcp__linear__save_issue', {}, { content: [{ type: 'text', text: '{"identifier":"eng-3"}' }] })!['work.item.id']).toBe('ENG-3')
    expect(linearTicket('mcp__linear__save_issue', {}, 'Issue ENG-9 created')!['work.item.id']).toBe('ENG-9')
    expect(linearTicket('mcp__linear__save_issue', {}, 'Saved GPT-5 notes')).toBeUndefined()
  })

  test("a Jira create or edit: the issue node's key, its address, the site's ID", () => {
    const result = JSON.stringify({ issues: { nodes: [{ id: '10003', key: 'KAN-4', webUrl: 'https://acme.atlassian.net/browse/KAN-4' }] }, context: { cloudId: 'cloud-1' } })
    expect(jiraTicket('mcp__atlassian__createJiraIssue', result)).toEqual({ 'work.item.id': 'KAN-4', 'work.item.op': 'created', 'work.item.url': 'https://acme.atlassian.net/browse/KAN-4', 'work.vendor': 'jira', 'work.instance': 'cloud-1' })
    expect(jiraTicket('mcp__atlassian__editJiraIssue', result)!['work.item.op']).toBe('updated')
    expect(jiraTicket('mcp__atlassian__editJiraIssue', 'not json')).toBeUndefined()
  })
})

describe('the plan snapshot', () => {
  const record = {
    oauthAccount: {
      accountUuid: ' acct-1 ', emailAddress: 'dev@example.com', organizationUuid: 'org-1', organizationType: 'claude_team', seatTier: 'team_tier_1', userRateLimitTier: 'default_claude_max_5x',
      billingType: 'stripe_subscription', organizationRole: 'user', profileFetchedAt: 1_800_000_000_000, hasExtraUsageEnabled: true,
    },
    claudeCodeFirstTokenDate: '2026-02-25T20:25:29Z',
    cachedExtraUsageDisabledReason: 'out_of_credits',
    cachedUsageUtilization: {
      accountUuid: 'acct-1', fetchedAtMs: 1_800_000_060_000,
      utilization: {
        five_hour: { utilization: 10, resets_at: '2026-11-19T19:10:00Z' },
        seven_day: { utilization: 20.5, resets_at: '2026-11-24T14:00:00Z' },
        seven_day_opus: { utilization: 1, resets_at: 'r' },
        seven_day_sonnet: null,
        limits: [
          { kind: 'session', group: 'session', percent: 10, severity: 'normal', is_active: false, resets_at: 'r1' },
          { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', is_active: false, resets_at: 'r2', scope: { model: { display_name: 'Fable' } } },
        ],
        extra_usage: { is_enabled: false, used_credits: 1250, monthly_limit: 5000, currency: 'USD', decimal_places: 2, spend_limit_reached: false, disabled_reason: 'out_of_credits', user_disabled: false },
      },
    },
    projects: { '/secret/path': { history: ['not read'] } },
  }

  test('the profile, the usage windows, the limits by kind and scope, and extra usage; nothing else in the record', async () => {
    const s = (await snapshotOf(record))!
    expect([s.accountUuid, s.email, s.organizationId]).toEqual(['acct-1', 'dev@example.com', 'org-1'])
    const P = 'mainwave.subscription.'
    expect(s.attributes).toEqual({
      [`${P}provider`]: 'anthropic', 'organization.id': 'org-1', [`${P}organization_type`]: 'claude_team', [`${P}seat_tier`]: 'team_tier_1', [`${P}rate_limit_tier`]: 'default_claude_max_5x',
      [`${P}billing_type`]: 'stripe_subscription', [`${P}organization_role`]: 'user', [`${P}first_token_date`]: '2026-02-25T20:25:29Z',
      [`${P}profile_observed_at`]: new Date(1_800_000_000_000).toISOString(), [`${P}extra_usage.enabled`]: false,
      [`${P}usage.five_hour.utilization`]: 10, [`${P}usage.five_hour.resets_at`]: '2026-11-19T19:10:00Z', [`${P}usage.seven_day.utilization`]: 20.5, [`${P}usage.seven_day.resets_at`]: '2026-11-24T14:00:00Z',
      [`${P}usage.seven_day_opus.utilization`]: 1, [`${P}usage.seven_day_opus.resets_at`]: 'r',
      [`${P}limit.session.group`]: 'session', [`${P}limit.session.percent`]: 10, [`${P}limit.session.severity`]: 'normal', [`${P}limit.session.is_active`]: false, [`${P}limit.session.resets_at`]: 'r1',
      [`${P}limit.weekly_scoped.fable.group`]: 'weekly', [`${P}limit.weekly_scoped.fable.percent`]: 0, [`${P}limit.weekly_scoped.fable.severity`]: 'normal', [`${P}limit.weekly_scoped.fable.is_active`]: false,
      [`${P}limit.weekly_scoped.fable.resets_at`]: 'r2', [`${P}limit.weekly_scoped.fable.scope_label`]: 'Fable',
      [`${P}extra_usage.used_minor`]: 1250, [`${P}extra_usage.limit_minor`]: 5000, [`${P}extra_usage.currency`]: 'USD', [`${P}extra_usage.exponent`]: 2, [`${P}extra_usage.spend_limit_reached`]: false,
      [`${P}extra_usage.disabled_reason`]: 'out_of_credits', [`${P}extra_usage.user_disabled`]: false, [`${P}extra_usage.cached_disabled_reason`]: 'out_of_credits',
      [`${P}observed_at`]: new Date(1_800_000_060_000).toISOString(),
    })
    expect(JSON.stringify(s)).not.toContain('secret')
  })

  test("another account's usage is never sent; no account, no snapshot", async () => {
    const other = { ...record, cachedUsageUtilization: { ...record.cachedUsageUtilization, accountUuid: 'acct-2' } }
    const s = (await snapshotOf(other))!
    expect(Object.keys(s.attributes).filter(k => k.includes('.usage.') || k.includes('.limit.'))).toEqual([])
    expect(s.attributes['mainwave.subscription.extra_usage.enabled']).toBe(true)
    expect(await snapshotOf({ oauthAccount: {} })).toBeUndefined()
    expect(await snapshotOfText('{')).toBeUndefined()
  })

  test('a long limit key keeps its prefix and a hash of the whole', async () => {
    const seg = (await limitKeySegment(`model-${'x'.repeat(80)}`))!
    expect(seg.length).toBeLessThanOrEqual(64)
    expect(seg).toMatch(/^model_x+_[0-9a-f]{8}$/)
    expect(await limitKeySegment('Weekly Scoped!')).toBe('weekly_scoped')
  })
})

describe('where the CLI sends them already', () => {
  const hook = (route: string) => ({ type: 'command', async: true, command: `f="$HOME/.mainwave/hooks/managed/mainwave-hook.sh"; [ -f "$f" ] && exec sh "$f" claude-code ${route}; exit 0` })
  const settings = {
    hooks: {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ ...hook('PostToolUse git'), if: 'Bash(git *)' }] }, { matcher: '^mcp__.*[Ll]inear.*', hooks: [hook('PostToolUse linear')] }],
      UserPromptSubmit: [{ hooks: [hook('UserPromptSubmit')] }],
      StopFailure: [{ hooks: [{ type: 'command', command: 'echo other' }] }],
    },
  }

  test("the kinds whose CLI hook the settings run, by the exact route, each with the script it runs: git is not github's gh, another command is not the CLI's", () => {
    const script = '/home/dev/.mainwave/hooks/managed/mainwave-hook.sh'
    expect([...cliHookKinds(settings, '/home/dev')].sort()).toEqual([['git', [script]], ['linear', [script]], ['snapshot', [script]]])
    expect([...cliHookKinds({ hooks: { PostToolUse: [{ hooks: [{ command: 'sh mainwave-hook.sh claude-code PostToolUse gitlab' }] }] } }, '/home/dev')]).toEqual([])
    expect([...cliHookKinds({}, '/home/dev')]).toEqual([])
    expect([...cliHookKinds(null)]).toEqual([])
  })

  test('the script a CLI hook command runs: the path it names, the home folder read in; the CLI\'s own place where it names none', () => {
    expect(cliScriptOf('f="${HOME}/x/mainwave-hook.sh"; [ -f "$f" ] && exec sh "$f" claude-code StopFailure', '/home/dev')).toBe('/home/dev/x/mainwave-hook.sh')
    expect(cliScriptOf('sh ~/y/mainwave-hook.sh claude-code StopFailure', '/home/dev')).toBe('/home/dev/y/mainwave-hook.sh')
    expect(cliScriptOf('sh /opt/mw/mainwave-hook.sh claude-code StopFailure', undefined)).toBe('/opt/mw/mainwave-hook.sh')
    expect(cliScriptOf('sh mainwave-hook.sh claude-code StopFailure', '/home/dev')).toBe('/home/dev/.mainwave/hooks/managed/mainwave-hook.sh')
    expect(cliScriptOf('sh "$HOME/z/mainwave-hook.sh" claude-code StopFailure', undefined)).toBeUndefined()
  })

  test('the CLI sends only with a key: an endpoint and an Authorization header, or a headers helper', () => {
    expect(cliCanSend('https://collector.example.com', 'Authorization=Bearer x', undefined)).toBe(true)
    expect(cliCanSend('https://collector.example.com', 'x-other=1,authorization = Bearer y', undefined)).toBe(true)
    expect(cliCanSend('https://collector.example.com', undefined, '/usr/local/bin/headers')).toBe(true)
    expect(cliCanSend('https://collector.example.com', 'x-other=1', undefined)).toBe(false)
    expect(cliCanSend(undefined, 'Authorization=Bearer x', undefined)).toBe(false)
    expect(cliCanSend('https://collector.example.com', 'Authorization=', undefined)).toBe(false)
  })
})

describe("a marker's resource and place", () => {
  test("the session's resource with the marker's source, service, host and version over it; not Claude Code's version", () => {
    expect(markerResource({ 'service.name': 'claude-code', 'service.version': '2.1.328', 'deployment.environment': 'production', 'mainwave.source': 'coding_agent.claude_code' }, 'git')).toEqual({
      'service.name': 'mainwave.git-hook', 'deployment.environment': 'production', 'mainwave.source': 'hook.git', 'mainwave.host_source': 'coding_agent.claude_code', 'mainwave.schema.version': '2',
    })
  })

  test('ids only: a malformed one is left out', () => {
    expect(placeAttributes({ caller: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }, toolCallId: 'toolu_1', agentId: 'agent 1', promptId: 'p-1' })).toEqual({
      'mainwave.caller.trace_id': 'a'.repeat(32), 'mainwave.caller.span_id': 'b'.repeat(16), 'gen_ai.tool.call.id': 'toolu_1', 'prompt.id': 'p-1',
    })
    expect(errorTypeOf('rate_limit')).toBe('rate_limit')
    expect(errorTypeOf('Rate limit: retry in 30s')).toBeUndefined()
  })
})

describe("a turn's API error, from its transcript", () => {
  const line = (row: Record<string, unknown>) => JSON.stringify(row)
  const failed = line({ type: 'assistant', uuid: 'm-2', isApiErrorMessage: true, error: 'overloaded', apiErrorStatus: 529, message: { content: [{ type: 'text', text: 'API Error: 529 m-1 retry' }] } })

  test("the kind on the message Claude Code wrote in place of the failed response, read by the message's id", () => {
    // The tail can start mid-line; another line can name the id; only the message's own line counts.
    const text = ['ial":true}', line({ type: 'last-prompt', leafUuid: 'm-2' }), failed, line({ type: 'cost-state' })].join('\n')
    expect(apiErrorIn(text, 'm-2')).toBe('overloaded')
  })

  test('a message that records no API error: none; one not written yet: null, so it is read again', () => {
    expect(apiErrorIn(line({ type: 'assistant', uuid: 'm-3', message: { content: [] } }), 'm-3')).toBeUndefined()
    expect(apiErrorIn(failed, 'm-9')).toBeNull()
    expect(apiErrorIn('', 'm-2')).toBeNull()
  })

  test('a word, never free text', () => {
    expect(apiErrorIn(line({ uuid: 'm-4', isApiErrorMessage: true, error: 'Rate limited: retry in 30s' }), 'm-4')).toBeUndefined()
    expect(apiErrorIn(line({ uuid: 'm-5', isApiErrorMessage: 'true', error: 'rate_limit' }), 'm-5')).toBeUndefined()
  })
})
