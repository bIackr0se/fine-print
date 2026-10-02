import type { On } from 'claude-code'
import { describe, expect, mock, test, tier } from 'claude-code/testing'

import { BASH_EXIT, BASH_OK, EDIT_OK } from './fixtures/shapes'

tier('user')

type Answer = Record<string, unknown>

function seat(on: On, results: Map<string, Answer>, surfaces: string[] = ['desktop'], fills = true, draft: string | Error | { gate: Promise<void>; started: () => void } = '', closeFails = false) {
  const seen = { status: [] as (string | undefined)[], logs: [] as string[], toasts: [] as string[], opened: [] as string[], closed: [] as string[], filled: [] as string[], forbidden: [] as string[] }
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: surfaces }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.call', ($, e) => (results.get(`${e.tool} ${String((e as Answer).command ?? (e as Answer).file_path ?? '')}`) ?? BASH_OK('')) as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', ($, e) => ({ text: e.answer }) as never)
  on('ui.status', ($, e) => { seen.status.push(e.text); return { value: undefined } })
  on('ui.log', ($, e) => { seen.logs.push(e.text); return { value: undefined } })
  on('ui.toast', ($, e) => { seen.toasts.push((e as Answer).text as string); return { value: undefined } })
  on('ui.open', ($, e) => { seen.opened.push(e.id); return { value: undefined } })
  on('ui.close', ($, e) => { if (closeFails) throw new Error('fixture close failure'); seen.closed.push(e.id); return { value: undefined } })
  on('ui.invalidate', () => ({ value: undefined }))
  on('prompt.read', async () => {
    if (draft instanceof Error) throw draft
    if (typeof draft === 'object') {
      draft.started()
      await draft.gate
      return { value: { text: '', cursor: 0 } } as never
    }
    return { value: { text: draft, cursor: draft.length } } as never
  })
  on('prompt.fill', ($, e) => { seen.filled.push(`${e.mode ?? 'replace'}:${e.text}`); return { isFilled: fills } as never })
  for (const event of ['model.complete', 'model.classify', 'model.fork', 'http.fetch', 'fs.write', 'fs.read', 'process.run', 'agent.spawn', 'prompt.submit', 'prompt.context'] as const) {
    on(event, () => { seen.forbidden.push(event); throw new Error(`fine-print must not call ${event}`) })
  }
  return Object.assign(seen, { clock })
}

const START = { surface: 'desktop' as never, isInteractive: false, cwd: '/w' }
const PANE = (surface: 'terminal' | 'desktop') => ({ plugin: 'fine-print', surface, component: 'Pane', requestId: 'fine-print', props: { title: 'Fine print', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } }) as const

async function messyTurn($: Parameters<Parameters<typeof test>[1]>[0]) {
  await $.session.start(START)
  await $.turn.start({ text: 'fix the discount bug', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/app.py', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/w/.env', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
  await $.tool.call({ tool: 'Bash', command: 'git push' })
  await $.turn.complete({ answer: 'I fixed the discount bug in `app.py`. All 12 tests pass.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
}

const MESSY = new Map<string, Answer>([
  ['Edit /w/app.py', EDIT_OK('/w/app.py')],
  ['Edit /w/.env', EDIT_OK('/w/.env')],
  ['Bash pytest -q', BASH_EXIT(1, '3 failed, 9 passed in 0.4s')],
  ['Bash git push', BASH_OK('To github.com:demo/shop.git\n   1a2b3c4..5d6e7f8  main -> main')],
])

describe('register', () => {
  for (const surface of ['desktop', 'terminal'] as const) {
    test(`${surface}: a turn that left things out opens the card; review steps the diff; ask fills the prompt box`, async ($, on) => {
      const seen = seat(on, MESSY)
      await messyTurn($)
      expect(seen.opened).toEqual(['fine-print'])
      expect(seen.status.at(-1)).toBe('fine print: 3 things the summary left out · 1 claim the record does not back · 1 sensitive file')

      const ui = await $.ui.mount(PANE(surface))
      expect((await ui.find({ key: 'item-0' }))?.text).toContain('exited 1 · 9 passed, 3 failed')
      expect((await ui.find({ key: 'item-2' }))?.text).toContain('pushed to a remote')
      expect((await ui.find({ key: 'items' }))?.text).not.toContain('app.py')

      expect((await ui.find({ key: 'item-1' }))?.text).toContain('.envsecrets/w/.env')
      expect((await ui.find({ key: 'item-1' }))?.text).toContain('-alpha+beta')
      expect((await ui.find({ key: 'item-1' }))?.text).toContain('Summary: the summary never names this file')
      expect((await ui.find({ key: 'item-2' }))?.text).toContain('$ git push')

      await ui.press({ key: 'diff-1' })
      await ui.unmount()
      const review = await $.ui.mount(PANE(surface))
      expect((await review.find({ key: 'head' }))?.text).toContain('change 1 of 1')
      expect((await review.find({ key: 'diff' }))?.text).toBe('-alpha+beta')

      await review.press({ key: 'ask' })
      expect(seen.filled, 'nothing runs inside the press dispatch').toEqual([])
      await seen.clock.advance(1)
      expect(seen.closed).toEqual(['fine-print'])
      expect(seen.filled).toHaveLength(1)
      expect(seen.filled[0]).toContain('replace:This turn you changed `/w/.env` (secrets)')
      expect(seen.filled[0]).not.toContain('git push')
      expect(seen.toasts.at(-1)).toBe('The question is in your prompt box: edit it, then press Enter.')
      expect(seen.forbidden).toEqual([])
    })
  }

  test('consumer: custom Close runs outside the press dispatch and one command reopens the card', async ($, on) => {
    const seen = seat(on, MESSY)
    await messyTurn($)
    const ui = await $.ui.mount(PANE('desktop'))
    await ui.press({ key: 'close' })
    expect(seen.closed, 'closing is deferred beyond the press dispatch').toEqual([])
    await seen.clock.advance(1)
    await seen.clock.settle()
    expect(seen.closed).toEqual(['fine-print'])
    const answer = await $.command.run({ command: 'fineprint', args: '', origin: { kind: 'composer' } })
    expect(answer.text).toBe('Fine print shown')
    expect(seen.opened).toEqual(['fine-print', 'fine-print'])
  })

  test('consumer: Ask completes dismissal before one command reopens the card', async ($, on) => {
    const seen = seat(on, MESSY)
    await messyTurn($)
    const ui = await $.ui.mount(PANE('desktop'))
    await ui.press({ key: 'ask-1' })
    await seen.clock.advance(1)
    await seen.clock.settle()
    const answer = await $.command.run({ command: 'fineprint', args: '', origin: { kind: 'composer' } })
    expect(answer.text).toBe('Fine print shown')
    expect(seen.opened).toEqual(['fine-print', 'fine-print'])
  })

  test('consumer: a failed close keeps the pane state and reports failure', async ($, on) => {
    const seen = seat(on, MESSY, ['desktop'], true, '', true)
    await messyTurn($)
    const ui = await $.ui.mount(PANE('desktop'))
    await ui.press({ key: 'close' })
    await seen.clock.advance(1)
    await seen.clock.settle()
    expect(seen.closed).toEqual([])
    expect(seen.toasts.at(-1)).toBe('Could not close Fine Print. Try /fineprint again.')
    expect(seen.logs.at(-1)).toContain('fine-print: close failed:')
    const answer = await $.command.run({ command: 'fineprint', args: '', origin: { kind: 'composer' } })
    expect(answer.text).toBe('Fine print could not be closed')
    expect(seen.opened).toEqual(['fine-print'])
  })

  test('when the prompt box cannot be filled, the card keeps the question and shows it', async ($, on) => {
    const seen = seat(on, MESSY, ['desktop'], false)
    await messyTurn($)
    const ui = await $.ui.mount(PANE('desktop'))
    await ui.press({ key: 'ask-1' })
    await seen.clock.advance(1)
    expect(seen.closed).toEqual([])
    expect(seen.toasts.at(-1)).toBe('Could not reach the prompt box; the question is shown in the card.')
    await ui.unmount()
    const shown = await $.ui.mount(PANE('desktop'))
    expect((await shown.find({ key: 'question' }))?.text).toContain('This turn you changed `/w/.env` (secrets)')
  })

  test('FP-002: an existing draft is kept; the question is appended after it', async ($, on) => {
    const seen = seat(on, MESSY, ['desktop'], true, 'also check the totals')
    await messyTurn($)
    const ui = await $.ui.mount(PANE('desktop'))
    await ui.press({ key: 'ask-1' })
    await seen.clock.advance(1)
    expect(seen.filled).toHaveLength(1)
    expect(seen.filled[0]).toMatch(/^append:\n\nThis turn you changed `\/w\/\.env`/)
    expect(seen.toasts.at(-1)).toBe('The question was added after your draft: edit it, then press Enter.')
  })

  test('FP-002: a deferred Ask from a card that a new turn replaced fills nothing', async ($, on) => {
    const seen = seat(on, MESSY)
    await messyTurn($)
    const ui = await $.ui.mount(PANE('desktop'))
    await ui.press({ key: 'ask-1' })
    await $.tool.call({ tool: 'Edit', file_path: '/w/app.py', old_string: 'a', new_string: 'b' })
    await $.turn.complete({ answer: 'I changed `app.py`.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    await seen.clock.advance(1)
    expect(seen.filled).toEqual([])
    expect(seen.toasts.at(-1)).toBe('That card is out of date. Ask again from the current one.')
  })

  test('closure: a new turn while the prompt box is being read cancels the fill', async ($, on) => {
    let release = () => {}
    let started = () => {}
    const gate = new Promise<void>(r => { release = r })
    const reading = new Promise<void>(r => { started = r })
    const seen = seat(on, MESSY, ['desktop'], true, { gate, started })
    await messyTurn($)
    const ui = await $.ui.mount(PANE('desktop'))
    await ui.press({ key: 'ask-1' })
    const firing = seen.clock.advance(1)
    await reading
    await $.tool.call({ tool: 'Edit', file_path: '/w/app.py', old_string: 'a', new_string: 'b' })
    await $.turn.complete({ answer: 'I changed `app.py`.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    release()
    await firing
    await seen.clock.settle()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(seen.filled).toEqual([])
    expect(seen.toasts.at(-1)).toBe('That card is out of date. Ask again from the current one.')
  })

  test('closure: a prompt box that cannot be read shows the question instead of guessing', async ($, on) => {
    const seen = seat(on, MESSY, ['desktop'], true, new Error('no prompt box'))
    await messyTurn($)
    const ui = await $.ui.mount(PANE('desktop'))
    await ui.press({ key: 'ask-1' })
    await seen.clock.advance(1)
    expect(seen.filled).toEqual([])
    expect(seen.toasts.at(-1)).toBe('Could not read your prompt box; the question is shown in the card.')
    await ui.unmount()
    const shown = await $.ui.mount(PANE('desktop'))
    expect((await shown.find({ key: 'question' }))?.text).toContain('This turn you changed `/w/.env` (secrets)')
  })

  test('FP-002: /clear between the press and the timer also cancels the Ask', async ($, on) => {
    const seen = seat(on, MESSY)
    await messyTurn($)
    const ui = await $.ui.mount(PANE('desktop'))
    await ui.press({ key: 'ask-0' })
    await $.command.run({ command: 'clear', args: '', origin: { kind: 'composer' } }).catch(() => undefined)
    await seen.clock.advance(1)
    expect(seen.filled).toEqual([])
  })

  test('FP-001: a subagent edit in the same turn stays out of the main card', async ($, on) => {
    const seen = seat(on, new Map([['Edit /w/sub/x.ts', EDIT_OK('/w/sub/x.ts')]]))
    await $.session.start(START)
    await $.tool.call({ tool: 'Edit', file_path: '/w/sub/x.ts', old_string: 'a', new_string: 'b', agentId: 'agent-1' } as never)
    await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(seen.opened).toEqual([])
  })

  test('a turn whose answer covers everything opens nothing and clears the status', async ($, on) => {
    const seen = seat(on, new Map([['Edit /w/app.py', EDIT_OK('/w/app.py')], ['Bash pytest -q', BASH_OK('12 passed in 0.4s')]]))
    await $.session.start(START)
    await $.turn.start({ text: 'x', turnId: 't1' })
    await $.tool.call({ tool: 'Edit', file_path: '/w/app.py', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'pytest -q' })
    await $.turn.complete({ answer: 'I changed `app.py`; all 12 tests pass.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(seen.opened).toEqual([])
    expect(seen.status.at(-1)).toBeUndefined()
  })

  test('/fineprint off keeps the card closed until asked; /fineprint opens it', async ($, on) => {
    const seen = seat(on, MESSY)
    await $.session.start(START)
    await $.command.run({ command: 'fineprint', args: 'off', origin: { kind: 'composer' } })
    await $.turn.start({ text: 'x', turnId: 't1' })
    await $.tool.call({ tool: 'Edit', file_path: '/w/.env', old_string: 'a', new_string: 'b' })
    await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(seen.opened).toEqual([])
    expect((await $.command.run({ command: 'fineprint', args: '', origin: { kind: 'composer' } })).text).toBe('Fine print shown')
    expect(seen.opened).toEqual(['fine-print'])
  })

  test('with no surface (claude -p) it logs the fine print and the question', async ($, on) => {
    const seen = seat(on, MESSY, [])
    await messyTurn($)
    expect(seen.opened).toEqual([])
    expect(seen.logs[0]).toContain('fine print · 3 things the summary left out')
    expect(seen.logs[0]).toContain('2. This turn you changed `/w/.env` (secrets)')
  })

  test('turn ends alone mark the turns (desktop raises no turn.start): a later clean turn does not inherit earlier fine print', async ($, on) => {
    const seen = seat(on, MESSY)
    await $.session.start(START)
    await $.tool.call({ tool: 'Edit', file_path: '/w/.env', old_string: 'a', new_string: 'b' })
    await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    expect(seen.opened).toEqual(['fine-print'])
    await $.tool.call({ tool: 'Edit', file_path: '/w/app.py', old_string: 'a', new_string: 'b' })
    await $.turn.complete({ answer: 'I changed `app.py`.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    expect(seen.status.at(-1)).toBeUndefined()
    const ui = await $.ui.mount(PANE('desktop'))
    expect((await ui.find({ text: /No fine print/ }))?.text).toContain('No fine print')
  })

  test('/clear forgets the turn', async ($, on) => {
    seat(on, MESSY)
    await messyTurn($)
    await $.command.run({ command: 'clear', args: '', origin: { kind: 'composer' } }).catch(() => undefined)
    const ui = await $.ui.mount(PANE('desktop'))
    expect((await ui.find({ text: /No fine print/ }))?.text).toContain('No fine print')
  })
})
