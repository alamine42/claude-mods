import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActionItem } from '../types'

const items = atom({ plugin: 'my-actions', key: 'items' } as const, [])
const isUpdating = atom({ plugin: 'my-actions', key: 'isUpdating' } as const, false)

const SYSTEM = `You track the open to-do list that a coding agent has left for its human user.

An item belongs on the list only when the HUMAN must do something:
- "action": a thing the human must do outside the chat. Examples: run a command, merge or check a PR, set a secret, restart an app, approve something, test something by hand.
- "question": a question the agent asked the human and is waiting on, or a choice the agent wants the human to make.

Not items: work the agent did, work the agent says it will do, findings, summaries, and offers the agent makes in passing with no real need for an answer.

You get the open list, the human's latest message, and the agent's latest reply. Return the new open list:
- Keep an open item unless the human's message answers it, the human says it is done, or the reply shows it is done or no longer needed.
- Add new items from the agent's latest reply. Do not add an item that is already on the list.
- Keep the "id" of each kept item. Give each new item the id "new".
- "text": one short imperative line, 12 words or fewer. For a question, write the question itself.
- "command": the exact shell command when the action is to run one; otherwise leave it out.

Reply with JSON only, no prose and no code fence: {"items":[{"id":"...","kind":"action"|"question","text":"...","command":"..."}]}`

let model = 'haiku'
let lastPrompt = ''
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
      const list = next.map(i => (known.has(i.id) && !isRebuild ? i : { ...i, id: `a${++counter}` }))
      await update($, items, () => list)
      const added = list.filter(i => !known.has(i.id)).length
      if (added && !isRebuild) $.ui.toast(`${added} new item${added === 1 ? '' : 's'} for you`)
      showStatus($, list)
    } finally {
      await update($, isUpdating, () => false)
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
  if ((await read($, items)).length) return
  const rows = (await $.session.messages()).filter(row => row.text.trim())
  const lastAgent = rows.map(row => row.role).lastIndexOf('assistant')
  if (lastAgent < 0) return
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

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || !e.answer.trim()) return result

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
    const room = Math.max(1, e.props.maxRows - 2)
    const shown = list.slice(0, room)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Box>
          <Text bold color="yellow">Your move</Text>
          <Text dimColor> · {list.length} open{busy ? ' · updating…' : ''}  </Text>
          <Button key="clear" label="Clear all" plain onPress={() => dismiss($, null)} />
        </Box>
        {shown.map((item, i) => (
          <Box>
            <Text color={item.kind === 'question' ? 'cyan' : 'yellow'}>{item.kind === 'question' ? '? ' : '▸ '}</Text>
            <Box flexGrow={1}>
              <Text wrap="truncate-end">
                {item.text}
                {item.command ? <Text dimColor> `{item.command}`</Text> : null}
              </Text>
            </Box>
            <Text> </Text>
            <Button
              key={`done-${item.id}`}
              label="Done"
              plain
              hotkey={i < 9 ? String(i + 1) : undefined}
              onPress={() => dismiss($, item.id)}
            />
          </Box>
        ))}
        {list.length > shown.length && <Text dimColor>+{list.length - shown.length} more</Text>}
      </Box>
    )
  })
}
