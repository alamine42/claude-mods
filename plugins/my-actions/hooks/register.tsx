import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActionItem } from '../types'

const items = atom({ plugin: 'my-actions', key: 'items' } as const, [])
const isUpdating = atom({ plugin: 'my-actions', key: 'isUpdating' } as const, false)

const SYSTEM = `You track the open to-do list that a coding agent has left for its human user.

An item belongs on the list only when the HUMAN must do something:
- "action": a thing the human must do. Examples: run a command, merge or check a PR, set a secret, restart an app, test something by hand, look at the screen.
- "question": a question the agent asked the human and is waiting on, or a choice the agent wants the human to make.

A request for permission is a "question", not an "action". When the agent offers to do a task once the human says yes ("Tell me if you want me to commit and push", "Shall I change the setting?"), write it as a question: "Commit and push the box changes?".

For each "action", set "owner":
- "you": only the human can do it. Examples: look at the app, test by hand, type in a password, use an account or device the agent cannot reach, start a new session.
- "agent": the agent has the tools to do it itself, but asked the human to. Examples: run a plain shell command in the repo, edit a file, check a PR with gh.

Not items: work the agent did, work the agent says it will do, findings, summaries, and offers the agent makes in passing with no real need for an answer.

You get the open list, the human's latest message, and the agent's latest reply. Return the new open list:
- Never add back a question that the human's message answers.
- Keep an open item unless the human's message answers it, the human says it is done, or the reply shows it is done or no longer needed.
- Add new items from the agent's latest reply. Do not add an item that is already on the list.
- Keep the "id" of each kept item. Give each new item the id "new".
- "text": one short imperative line, 12 words or fewer. For a question, write the question itself.
- "command": the exact shell command when the action is to run one; otherwise leave it out.
- Never list one task twice. A task is an "action" or a "question", not both. When the agent waits for a go-ahead to do it, it is a question; drop the action.

Reply with JSON only, no prose and no code fence: {"items":[{"id":"...","kind":"action"|"question","owner":"you"|"agent","text":"...","command":"..."}]}`

let model = 'haiku'
let lastPrompt = ''
let lastReply = ''
let counter = 0
let chain: Promise<void> = Promise.resolve()

function parse(text: string): ActionItem[] | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as { items?: unknown }
    if (!Array.isArray(raw.items)) return null
    return raw.items.flatMap((one: Record<string, unknown>) => {
      const kind = one.kind === 'question' ? 'question' : one.kind === 'action' ? 'action' : null
      const body = typeof one.text === 'string' ? one.text.trim() : ''
      if (!kind || !body) return []
      const item: ActionItem = { id: String(one.id ?? 'new'), kind, text: body }
      if (typeof one.command === 'string' && one.command.trim()) item.command = one.command.trim()
      if (kind === 'action') item.owner = one.owner === 'agent' ? 'agent' : 'you'
      return [item]
    })
  } catch {
    return null
  }
}

// Asks the small model for the new list and stores it. Calls run one after another.
function refresh($: EngineInterface, prompt: string, isRebuild: boolean) {
  chain = chain.then(async () => {
    await update($, isUpdating, () => true)
    try {
      const before = await read($, items)
      const r = await $.model.complete({ model, system: SYSTEM, prompt, maxTokens: 1500, timeoutMs: 45000 })
      if (!r.isAnswered) {
        $.ui.log(`my-actions: the model gave no answer (${r.reason})`)
        return
      }
      const next = parse(r.text)
      if (!next) {
        $.ui.log('my-actions: the model reply was not valid JSON')
        return
      }
      const known = new Set(before.map(i => i.id))
      const list = dedupe(next).map(i => (known.has(i.id) && !isRebuild ? i : { ...i, id: `a${++counter}` }))
      await update($, items, () => list)
      const added = list.filter(i => !known.has(i.id)).length
      if (added && !isRebuild) $.ui.toast(`${added} new item${added === 1 ? '' : 's'} for you`)
      showStatus($, list)
    } finally {
      await update($, isUpdating, () => false)
    }
  }).catch(() => undefined)
}

const WORD = /[a-z0-9]+/g
const STOP = new Set(['the', 'a', 'an', 'to', 'and', 'or', 'of', 'in', 'on', 'for', 'it', 'is', 'you', 'me', 'my', 'your', 'this', 'that', 'should', 'shall', 'do', 'i', 'we'])
const words = (text: string) => new Set((text.toLowerCase().match(WORD) ?? []).filter(w => !STOP.has(w)))

// True when two lines name the same task: most of their words are the same.
function isSameTask(a: ActionItem, b: ActionItem) {
  const x = words(a.text)
  const y = words(b.text)
  if (!x.size || !y.size) return false
  let shared = 0
  for (const w of x) if (y.has(w)) shared++
  return shared / Math.min(x.size, y.size) >= 0.6
}

// A task in both boxes keeps one place: a go-ahead the agent waits on stays a question,
// a task only the person can do stays an action.
function dedupe(list: ActionItem[]) {
  const actions = list.filter(i => i.kind === 'action')
  return list.filter(item => {
    if (item.kind === 'action') {
      return item.owner !== 'agent' || !list.some(q => q.kind === 'question' && isSameTask(q, item))
    }
    return !actions.some(a => a.owner !== 'agent' && isSameTask(a, item))
  })
}

const ANSWERED = `A human sent a message to a coding agent. Decide which open items on the human's list the message settles.

An item is settled when the message answers the question (a plain "yes", "no", "go ahead" or a choice answers the question the agent asked last), or says the task is done, or says to drop it.

Reply with JSON only, no prose and no code fence: {"settled":["id", ...]}. Use [] when the message settles nothing.`

// Clears the items the person's message settles, as soon as they send it.
function settle($: EngineInterface, message: string) {
  chain = chain.then(async () => {
    const open = await read($, items)
    if (!open.length || !message.trim()) return
    const r = await $.model.complete({
      model,
      system: ANSWERED,
      prompt: [
        `OPEN ITEMS:\n${JSON.stringify({ items: open })}`,
        `AGENT'S LAST REPLY:\n${clip(lastReply, 8000) || '(none)'}`,
        `HUMAN'S MESSAGE:\n${clip(message, 4000)}`,
      ].join('\n\n'),
      maxTokens: 300,
      timeoutMs: 20000,
    })
    if (!r.isAnswered) return
    const start = r.text.indexOf('{')
    const end = r.text.lastIndexOf('}')
    if (start < 0 || end <= start) return
    try {
      const { settled } = JSON.parse(r.text.slice(start, end + 1)) as { settled?: unknown }
      if (!Array.isArray(settled) || !settled.length) return
      const ids = new Set(settled.map(String))
      await update($, items, l => l.filter(one => !ids.has(one.id)))
      showStatus($, await read($, items))
    } catch {
      // A reply that is not JSON settles nothing; the end-of-turn update still runs.
    }
  }).catch(() => undefined)
}

function showStatus($: EngineInterface, list: ActionItem[]) {
  const actions = list.filter(i => i.kind === 'action').length
  const questions = list.length - actions
  if (!list.length) {
    $.ui.status(undefined)
    return
  }
  const parts = [
    actions ? `${actions} action${actions === 1 ? '' : 's'}` : '',
    questions ? `${questions} question${questions === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  $.ui.status(`Your move: ${parts.join(', ')}`)
}

async function dismiss($: EngineInterface, id: string | null) {
  await update($, items, l => (id === null ? [] : l.filter(one => one.id !== id)))
  showStatus($, await read($, items))
}

// On load or resume, read the last exchanges so the box is right before the next turn ends.
async function bootstrap($: EngineInterface) {
  const rows = (await $.session.messages()).filter(row => row.text.trim())
  const lastAgent = rows.map(row => row.role).lastIndexOf('assistant')
  if (lastAgent < 0) return
  lastReply = rows[lastAgent].text
  if ((await read($, items)).length) return
  const recent = rows
    .slice(Math.max(0, lastAgent - 5), lastAgent + 1)
    .map(row => `${row.role === 'user' ? 'HUMAN' : 'AGENT'}: ${row.text.trim()}`)
    .join('\n\n')
  refresh($, [
    'OPEN LIST:\n{"items":[]}',
    'Build the list from the recent conversation below. An item stays open only if nothing later in it closes it.',
    `CONVERSATION:\n${clip(recent, 30000)}`,
  ].join('\n\n'), true)
}

async function clearKind($: EngineInterface, kind: ActionItem['kind']) {
  await update($, items, l => l.filter(one => one.kind !== kind))
  showStatus($, await read($, items))
}

const clip = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text)

export const register: Register = (on, options) => {
  if (typeof options.model === 'string' && options.model) model = options.model

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'my-actions',
      description: 'Rebuild the list of your open actions and questions from the whole session. "clear" empties it',
    })
    showStatus($, await read($, items))
    $.clock.after(10, () => void bootstrap($))

    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    lastPrompt = e.text
    // The model call outlives this dispatch, so start it from a timer.
    $.clock.after(10, () => settle($, e.text))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || !e.answer.trim()) return result
    lastReply = e.answer

    const open = await read($, items)
    const prompt = [
      `OPEN LIST:\n${JSON.stringify({ items: open })}`,
      `HUMAN'S LATEST MESSAGE:\n${clip(lastPrompt, 4000) || '(none)'}`,
      `AGENT'S LATEST REPLY:\n${clip(e.answer, 20000)}`,
    ].join('\n\n')
    // The model call outlives this dispatch, so start it from a timer.
    $.clock.after(10, () => refresh($, prompt, false))

    return result
  })

  on('command.run', { command: 'my-actions' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await update($, items, () => [])
      showStatus($, [])
      return { text: 'Cleared your action list.' }
    }
    const rows = await $.session.messages()
    const transcript = rows
      .filter(row => row.text.trim())
      .map(row => `${row.role === 'user' ? 'HUMAN' : 'AGENT'}: ${row.text.trim()}`)
      .join('\n\n')
    const prompt = [
      'OPEN LIST:\n{"items":[]}',
      'Build the list from the whole conversation below. An item stays open only if nothing later in the conversation closes it.',
      `CONVERSATION:\n${clip(transcript, 80000)}`,
    ].join('\n\n')
    $.clock.after(10, () => refresh($, prompt, true))

    return { text: 'Rebuilding your action list from this session.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, items)
    const busy = await read($, isUpdating)
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    // The tasks only you can do come first.
    const todos = list.filter(i => i.kind === 'action' && i.owner !== 'agent').concat(list.filter(i => i.kind === 'action' && i.owner === 'agent'))
    const questions = list.filter(i => i.kind === 'question')
    const boxes = (todos.length ? 1 : 0) + (questions.length ? 1 : 0)

    // Side by side when there is room, else one box above the other.
    // A band taller than the room scrolls, so every item shows in full.
    const isWide = boxes === 2 && e.props.bodyColumns >= 100

    const row = (item: ActionItem, n: number) => {
      const isAgents = item.kind === 'action' && item.owner === 'agent'
      return (
        <Box>
          <Text color={item.kind === 'question' ? 'cyan' : isAgents ? 'gray' : 'yellow'}>
            {item.kind === 'question' ? '? ' : isAgents ? '↻ ' : '▸ '}
          </Text>
          <Box flexGrow={1}>
            <Text wrap="wrap" dimColor={isAgents}>
              {item.text}
              {item.command ? <Text dimColor> `{item.command}`</Text> : null}
              {isAgents ? <Text dimColor italic> · the agent can do this</Text> : null}
            </Text>
          </Box>
          <Text> </Text>
          <Button
            key={`done-${item.id}`}
            label="Done"
            plain
            hotkey={n <= 9 ? String(n) : undefined}
            onPress={() => dismiss($, item.id)}
          />
        </Box>
      )
    }

    const box = (kind: ActionItem['kind'], title: string, color: string, group: ActionItem[], first: number, isFirst: boolean) =>
      group.length > 0 && (
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={color} paddingX={1}>
          <Box marginBottom={1}>
            <Box flexGrow={1}>
              <Text bold color={color}>
                {title} ({group.length})
                {busy && isFirst ? <Text dimColor> · updating…</Text> : null}
              </Text>
            </Box>
            <Button key={`clear-${kind}`} label="Clear" plain onPress={() => clearKind($, kind)} />
          </Box>
          {group.map((item, i) => row(item, first + i))}
        </Box>
      )

    return (
      <Box flexDirection={isWide ? 'row' : 'column'}>
        {box('action', 'To do', 'yellow', todos, 1, true)}
        {box('question', 'Questions', 'cyan', questions, todos.length + 1, todos.length === 0)}
      </Box>
    )
  })
}
