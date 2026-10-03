import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mark, Pipeline, Stage } from '../types'

const PANE = 'ci-pipeline'
const pipeline = atom({ plugin: 'ci-pipeline', key: 'pipeline' } as const, null)
const pinned = atom({ plugin: 'ci-pipeline', key: 'pinned' } as const, null)

const NAMES = [
  'Local dev',
  'PR open',
  'PR checks running',
  'PR merged',
  'Deploying to Staging',
  'Staging Deployed',
  'Smoke Testing Staging',
  'Staging Smoke Tested',
  'Deploying to Prod',
  'Prod Deployed',
  'Smoke Testing Prod',
  'Prod Smoke Tested',
]

const GROUPS = [
  { title: 'Code', from: 0, to: 4 },
  { title: 'Staging', from: 4, to: 8 },
  { title: 'Production', from: 8, to: 12 },
]

const GLYPH: Record<Mark, string> = {
  done: '✓',
  running: '●',
  failed: '✗',
  waiting: '◌',
  pending: '·',
}

const COLOR: Record<Mark, string | undefined> = {
  done: 'green',
  running: 'yellow',
  failed: 'red',
  waiting: 'cyan',
  pending: undefined,
}

type Job = { label: string; status: string; conclusion: string }
type Result = 'running' | 'failed' | 'done' | null

// A GitHub job or check state, folded to one result.
const resultOf = (status: string, conclusion: string): Result => {
  const s = status.toLowerCase()
  const c = conclusion.toLowerCase()
  if (s && s !== 'completed') return 'running'
  if (['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'].includes(c)) return 'failed'
  if (c === 'skipped' || c === 'neutral') return null
  return 'done'
}

// Many jobs for one stage: any failure wins, then any running job.
const summarise = (jobs: Job[]): Result => {
  const results = jobs.map(j => resultOf(j.status, j.conclusion)).filter(r => r !== null)
  if (results.length === 0) return null
  if (results.includes('failed')) return 'failed'
  if (results.includes('running')) return 'running'
  return 'done'
}

const toRegex = (source: unknown, fallback: string) => {
  try {
    return new RegExp(typeof source === 'string' && source ? source : fallback, 'i')
  } catch {
    return new RegExp(fallback, 'i')
  }
}

let match = {
  smokeStaging: /smoke.*stag|stag.*smoke/i,
  smokeProd: /smoke.*prod|prod.*smoke/i,
  deployStaging: /deploy.*stag|stag.*deploy/i,
  deployProd: /deploy.*prod|prod.*deploy/i,
}

// Jobs of completed runs do not change, so keep them for the module's life.
const doneRuns = new Map<number, Job[]>()
let isBusy = false

async function run($: EngineInterface, argv: string[]) {
  const out = await $.process.run(argv, { timeoutMs: 20000 })
  return { ok: out.exitCode === 0, text: out.stdout.trim(), err: out.stderr.trim() }
}

async function jobsFor($: EngineInterface, sha: string): Promise<Job[]> {
  const list = await run($, [
    'gh', 'run', 'list', '--commit', sha, '--limit', '30',
    '--json', 'databaseId,workflowName,status,conclusion',
  ])
  if (!list.ok) return []
  const runs = JSON.parse(list.text || '[]') as {
    databaseId: number; workflowName: string; status: string; conclusion: string
  }[]
  const all: Job[] = []
  for (const r of runs) {
    const kept = doneRuns.get(r.databaseId)
    if (kept) {
      all.push(...kept)
      continue
    }
    const view = await run($, ['gh', 'run', 'view', String(r.databaseId), '--json', 'jobs'])
    if (!view.ok) continue
    const { jobs } = JSON.parse(view.text) as { jobs: { name: string; status: string; conclusion: string }[] }
    const mapped = jobs.map(j => ({
      label: `${r.workflowName} / ${j.name}`,
      status: j.status ?? '',
      conclusion: j.conclusion ?? '',
    }))
    if (r.status === 'completed') doneRuns.set(r.databaseId, mapped)
    all.push(...mapped)
  }
  return all
}

async function build($: EngineInterface): Promise<Pipeline> {
  const stages: Stage[] = NAMES.map(name => ({ name, mark: 'pending' as Mark }))
  const updatedAt = await $.clock.now()
  const head = await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
  if (!head.ok) return { branch: null, pr: null, stages, error: 'Not a git repository', updatedAt }
  const branch = head.text

  const pin = await read($, pinned)
  const view = await run($, [
    'gh', 'pr', 'view', ...(pin ? [String(pin)] : []),
    '--json', 'number,title,url,state,mergedAt,mergeCommit,statusCheckRollup',
  ])

  if (!view.ok) {
    const dirty = await run($, ['git', 'status', '--porcelain'])
    const ahead = await run($, ['git', 'rev-list', '--count', '@{u}..HEAD'])
    const changed = dirty.ok && dirty.text ? dirty.text.split('\n').length : 0
    const notes = [
      changed ? `${changed} changed file${changed === 1 ? '' : 's'}` : 'clean',
      ahead.ok ? `${ahead.text} unpushed` : 'no upstream',
    ]
    stages[0] = { ...stages[0], mark: 'running', note: notes.join(', ') }
    const isNoPr = /no pull requests? found/i.test(view.err)
    return { branch, pr: null, stages, error: isNoPr ? undefined : view.err.split('\n')[0], updatedAt }
  }

  const pr = JSON.parse(view.text) as {
    number: number; title: string; url: string; state: string; mergedAt: string | null
    mergeCommit: { oid: string } | null
    statusCheckRollup: { status?: string; conclusion?: string; state?: string }[] | null
  }
  stages[0] = { ...stages[0], mark: 'done' }
  stages[1] = { ...stages[1], mark: 'done', note: `#${pr.number}` }

  // CheckRun has status/conclusion; StatusContext has state only.
  const checks = (pr.statusCheckRollup ?? []).map(c =>
    c.state !== undefined
      ? resultOf(c.state === 'PENDING' || c.state === 'EXPECTED' ? 'in_progress' : 'completed', c.state === 'SUCCESS' ? 'success' : 'failure')
      : resultOf(c.status ?? '', c.conclusion ?? ''),
  )
  const total = checks.filter(c => c !== null).length
  const running = checks.filter(c => c === 'running').length
  const failed = checks.filter(c => c === 'failed').length
  if (running) stages[2] = { ...stages[2], mark: 'running', note: `${total - running}/${total} done` }
  else if (failed) stages[2] = { ...stages[2], mark: 'failed', note: `${failed} of ${total} failed` }
  else stages[2] = { ...stages[2], mark: 'done', note: total ? `${total} passed` : 'no checks' }

  if (pr.state === 'CLOSED') stages[3] = { ...stages[3], mark: 'failed', note: 'closed without merge' }
  if (pr.state === 'MERGED') {
    stages[3] = { ...stages[3], mark: 'done' }
    const jobs = pr.mergeCommit ? await jobsFor($, pr.mergeCommit.oid) : []
    const pick = (re: RegExp, not?: RegExp) => jobs.filter(j => re.test(j.label) && !(not && not.test(j.label)))
    const envs = [
      { at: 4, deploy: pick(match.deployStaging, match.smokeStaging), smoke: pick(match.smokeStaging) },
      { at: 8, deploy: pick(match.deployProd, match.smokeProd), smoke: pick(match.smokeProd) },
    ]
    for (const env of envs) {
      for (const [offset, group] of [[0, env.deploy], [2, env.smoke]] as const) {
        const result = summarise(group)
        const i = env.at + offset
        if (result === 'running') stages[i] = { ...stages[i], mark: 'running', note: group[0]?.label }
        if (result === 'failed') stages[i] = { ...stages[i], mark: 'failed', note: group.find(j => resultOf(j.status, j.conclusion) === 'failed')?.label }
        if (result === 'done') {
          stages[i] = { ...stages[i], mark: 'done' }
          stages[i + 1] = { ...stages[i + 1], mark: 'done' }
        }
      }
    }
  }

  // The first open stage after an unbroken run of done stages is the one we wait on.
  const next = stages.findIndex(s => s.mark !== 'done')
  if (next >= 0 && stages[next].mark === 'pending') stages[next] = { ...stages[next], mark: 'waiting' }

  return { branch, pr: { number: pr.number, title: pr.title, url: pr.url }, stages, updatedAt }
}

const current = (p: Pipeline) =>
  p.stages.find(s => s.mark === 'failed' || s.mark === 'running' || s.mark === 'waiting') ??
  [...p.stages].reverse().find(s => s.mark === 'done')

async function refresh($: EngineInterface) {
  if (isBusy) return
  isBusy = true
  try {
    const before = await read($, pipeline)
    const after = await build($)
    await update($, pipeline, () => after)
    const now = current(after)
    if (now && after.branch) $.ui.status(`CI ${GLYPH[now.mark]} ${now.name}`)
    const was = before && current(before)
    const isSameTarget = before?.branch === after.branch && before?.pr?.number === after.pr?.number
    if (now && was && isSameTarget && (was.name !== now.name || was.mark !== now.mark)) {
      $.ui.toast(`CI: ${now.name}${now.mark === 'failed' ? ' failed' : ''}`)
    }
  } catch (err) {
    $.ui.status(`CI ? ${String(err).slice(0, 60)}`)
  } finally {
    isBusy = false
  }
}

export const register: Register = (on, options) => {
  match = {
    smokeStaging: toRegex(options.smokeStaging, 'smoke.*stag|stag.*smoke'),
    smokeProd: toRegex(options.smokeProd, 'smoke.*prod|prod.*smoke'),
    deployStaging: toRegex(options.deployStaging, 'deploy.*stag|stag.*deploy'),
    deployProd: toRegex(options.deployProd, 'deploy.*prod|prod.*deploy'),
  }
  const pollMs = Math.max(5, Number(options.pollSeconds) || 20) * 1000

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pipeline',
      description: 'Show the CI/CD pipeline pane. Args: a PR number to pin, "branch" to follow the current branch',
    })
    void $.ui.open({ id: PANE, title: 'Pipeline' })
    void refresh($)
    $.clock.every(pollMs, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'pipeline' }, async ($, e) => {
    const arg = e.args.trim()
    if (/^\d+$/.test(arg)) await update($, pinned, () => Number(arg))
    if (arg === 'branch') await update($, pinned, () => null)
    await $.ui.open({ id: PANE, title: 'Pipeline' })
    void refresh($)
    const pin = await read($, pinned)

    return { text: pin ? `Pipeline pane open, following PR #${pin}.` : 'Pipeline pane open, following the current branch.' }
  })

  // Pushes and PRs often happen inside a turn, so look again when it ends.
  on('turn.complete', async ($, e, next) => {
    void refresh($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const p = await read($, pipeline)
    const pin = await read($, pinned)

    if (!p) return <Text dimColor>Reading pipeline status…</Text>

    const time = new Date(p.updatedAt).toLocaleTimeString()
    const target = p.pr ? `PR #${p.pr.number} ${p.pr.title}` : 'no PR yet'

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">{p.branch ?? '—'}{pin ? ' (pinned)' : ''}</Text>
        <Text dimColor wrap="truncate-end">{target}</Text>
        {p.error && <Text color="red" wrap="truncate-end">{p.error}</Text>}
        {GROUPS.map(g => (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{g.title}</Text>
            {p.stages.slice(g.from, g.to).map(s => (
              <Box>
                <Text color={COLOR[s.mark]} dimColor={s.mark === 'pending'}>{GLYPH[s.mark]} </Text>
                <Text bold={s.mark === 'running' || s.mark === 'waiting' || s.mark === 'failed'} dimColor={s.mark === 'pending'} wrap="truncate-end">
                  {s.name}
                  {s.note ? <Text dimColor> {s.note}</Text> : null}
                </Text>
              </Box>
            ))}
          </Box>
        ))}
        <Box marginTop={1}>
          <Text dimColor>Updated {time} </Text>
          <Button key="refresh" label="Refresh" hotkey="r" plain onPress={() => void refresh($)} />
        </Box>
      </Box>
    )
  })
}
