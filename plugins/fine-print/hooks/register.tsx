import type { On } from 'claude-code'

import { type FinePrint, finePrintOf, headlineOf, questionFor } from './audit'
import { eventOf, type ToolEvent } from './ledger'
import { cardView, changesOf, type View } from './view'

export const COMMAND = 'fineprint'
export const PANE_ID = 'fine-print'

/** Housekeeping bound on memory, not on what is shown. */
const MAX_EVENTS = 5_000

type Host = {
  surfaces: () => Promise<readonly string[]>
  status: (text: string | undefined) => void
  log: (text: string) => void
  debug: (text: string) => void
  toast: (text: string) => void
  redraw: () => void
  openPane: () => Promise<void>
  closePane: () => Promise<void>
  /** The prompt box's current draft (empty where the session draws none). */
  draft: () => Promise<string>
  fill: (text: string, mode: 'replace' | 'append') => Promise<boolean>
  /** Runs work outside the dispatch that asked for it (a press), so it is not cut short with that dispatch. */
  later: (fn: () => void) => void
}

/**
 * Fine Print: at the end of each turn, compares Claude's final answer with
 * what the turn's tool calls actually did, and when the answer left something
 * out (a change it never named, a command with side effects it never
 * mentioned, a claim the record does not back) opens a card with it, a
 * step-through of the unmentioned diffs, and a question per item for the prompt box.
 * Observes only: no model, network or file calls; nothing is sent for you.
 */
export function register(on: On) {
  let host: Host | null = null
  let isAuto = true
  let isOpen = false
  /** Turns are counted by their ends: desktop sessions raise turn.complete but no turn.start. */
  let turn = 1
  let seq = 0
  let events: ToolEvent[] = []
  let last: FinePrint | null = null
  let view: View = { mode: 'list' }
  let cwd = ''
  /** Bumped by every new card, /clear and /resume: a deferred Ask from an older card does nothing. */
  let generation = 0
  /** Only the latest open or close may settle the pane's state. */
  let paneOp = 0

  async function open() {
    if (!host) return
    const op = ++paneOp
    await host.openPane().catch(() => undefined)
    if (op === paneOp) isOpen = true
    host.redraw()
  }
  async function close(): Promise<boolean> {
    const h = host
    if (!h || !isOpen) return true
    const op = ++paneOp
    try {
      await h.closePane()
      if (op === paneOp) isOpen = false
      return true
    } catch (error) {
      h.toast('Could not close Fine Print. Try /fineprint again.')
      h.debug(`fine-print: close failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
  const actions = {
    review: (index: number) => { view = { mode: 'review', index }; host?.redraw() },
    back: () => { view = { mode: 'list' }; host?.redraw() },
    step: (delta: number) => {
      if (view.mode !== 'review' || !last) return
      const n = changesOf(last).length
      view = { mode: 'review', index: (view.index + delta + n) % n }
      host?.redraw()
    },
    close: () => {
      const closing = generation
      host?.later(() => { if (closing === generation) void close() })
    },
    ask: (index: number) => {
      const h = host
      const card = last
      const item = card?.items[index]
      if (!h || !card || !item) return
      const asked = generation
      const question = questionFor(item)
      h.later(() => {
        void (async () => {
          if (asked !== generation || last !== card) {
            h.toast('That card is out of date. Ask again from the current one.')
            return
          }
          const showQuestion = (why: string) => {
            view = { mode: 'question', index }
            h.redraw()
            h.toast(why)
          }
          let draft: string
          try {
            draft = (await h.draft()).trim()
          } catch {
            showQuestion('Could not read your prompt box; the question is shown in the card.')
            return
          }
          // the card may have been replaced while the box was being read
          if (asked !== generation || last !== card) {
            h.toast('That card is out of date. Ask again from the current one.')
            return
          }
          const filled = await h.fill(draft ? `\n\n${question}` : question, draft ? 'append' : 'replace').catch(() => false)
          if (asked !== generation) return
          if (filled) {
            h.toast(draft ? 'The question was added after your draft: edit it, then press Enter.' : 'The question is in your prompt box: edit it, then press Enter.')
            await close()
          } else {
            showQuestion('Could not reach the prompt box; the question is shown in the card.')
          }
        })()
      })
    },
  }

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: COMMAND, description: "Show what Claude's last answer left out: unmentioned changes, side-effect commands, unbacked claims", argumentHint: '[off | on]' })
      host = {
        surfaces: () => $.session.surfaces(),
        status: text => $.ui.status(text),
        log: text => $.ui.log(text),
        debug: text => $.ui.log(text, { to: 'debug' }),
        toast: text => $.ui.toast(text),
        redraw: () => $.ui.invalidate('ui.render'),
        openPane: () => $.ui.open({ id: PANE_ID, title: 'Fine print' }),
        closePane: () => $.ui.close({ id: PANE_ID }),
        draft: async () => (await $.prompt.read()).text,
        fill: async (text, mode) => (await $.prompt.fill({ text, mode })).isFilled,
        later: fn => { $.clock.after(0, fn) },
      }
      cwd = e.cwd
    } catch (error) {
      $.ui.log(`fine-print: /${COMMAND} not registered: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'Bash', 'Read'] }, async ($, e, next) => {
    const atMs = await $.clock.now()
    let result: unknown
    try {
      result = await next(e)
      return result as Awaited<ReturnType<typeof next>>
    } finally {
      const event = eventOf({ tool: e.tool, input: e as unknown as Record<string, unknown>, result }, { seq: ++seq, turn, atMs })
      if (event) {
        events.push(event)
        if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS)
      }
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const h = host
    const ended = turn
    turn += 1
    if (!h) return next(e)
    generation += 1
    last = finePrintOf(e.answer, events, ended)
    view = { mode: 'list' }
    const shown = last.items.length > 0

    h.status(shown ? `fine print: ${headlineOf(last.items)}` : undefined)
    const surfaces = await h.surfaces().catch(() => [] as readonly string[])
    if (!surfaces.length) {
      if (shown) h.log(`fine print · ${headlineOf(last.items)}\n${last.items.map((it, i) => `${i + 1}. ${questionFor(it)}`).join('\n')}`)
    } else if (shown && isAuto) {
      await open()
    } else if (isOpen) {
      h.redraw()
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return cardView({ Box, Text, Button }, last, view, actions, cwd)
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    const h = host
    if (!h) return next(e)
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'on') {
      isAuto = arg === 'on'
      return { text: `Fine print ${isAuto ? 'opens by itself when an answer leaves something out' : 'opens only on /fineprint'}` }
    }
    const surfaces = await h.surfaces().catch(() => [] as readonly string[])
    if (!surfaces.length) return { text: last?.items.length ? `${headlineOf(last.items)}\n${last.items.map((it, i) => `${i + 1}. ${questionFor(it)}`).join('\n')}` : 'No fine print in the last answer' }
    if (isOpen) {
      return { text: (await close()) ? 'Fine print closed' : 'Fine print could not be closed' }
    }
    view = { mode: 'list' }
    await open()
    return { text: 'Fine print shown' }
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)
    if ((result as { deny?: string } | undefined)?.deny === undefined) isOpen = false
    return result
  })

  on('command.run', { command: ['clear', 'resume'] }, async ($, e, next) => {
    await close()
    generation += 1
    turn = 1
    seq = 0
    events = []
    last = null
    view = { mode: 'list' }
    host?.status(undefined)
    return next(e)
  })
}
