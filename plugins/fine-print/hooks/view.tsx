import type { Elements, RenderElement } from 'claude-code'

import { type FinePrint, headlineOf, type Item, questionFor } from './audit'

export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export type View = { mode: 'list' } | { mode: 'review'; index: number } | { mode: 'question'; index: number }

export type Actions = {
  ask: (item: number) => void
  review: (change: number) => void
  step: (delta: number) => void
  back: () => void
  close: () => void
}

const INK = { bad: 'red', warn: 'yellow', add: 'green', del: 'red' } as const
const HUNK_PREVIEW = 6

const pad = (n: number) => String(n).padStart(2, '0')
/** A path as the workspace sees it: relative to the session's folder when inside it. */
export const relativeTo = (cwd: string, path: string) => (cwd && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path)

const clock = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }

/** The changes a review steps through: unmentioned edits, in card order. */
export const changesOf = (fp: FinePrint) => fp.items.filter((i): i is Extract<Item, { kind: 'change' }> => i.kind === 'change')

function diffLines(kit: Kit, lines: string[], keyPrefix: string): RenderElement[] {
  const { Text } = kit
  return lines.map((l, i) => (
    <Text key={`${keyPrefix}${i}`} color={l.startsWith('+') ? INK.add : l.startsWith('-') ? INK.del : undefined} dimColor={!l.startsWith('+') && !l.startsWith('-')}>{l === '' ? ' ' : l}</Text>
  ))
}

function itemCard(kit: Kit, fp: FinePrint, item: Item, i: number, act: Actions, cwd: string): RenderElement {
  const { Box, Text, Button } = kit
  const ask = <Button key={`ask-${i}`} label="Ask Claude" hotkey={i < 9 ? String(i + 1) : undefined} variant={i === 0 ? 'primary' : undefined} onPress={() => act.ask(i)} />

  let mark: RenderElement
  let title: RenderElement
  let body: RenderElement[]
  let coverage: string

  if (item.kind === 'claim') {
    const v = item.receipt.verdict
    mark = v === 'contradicted' ? <Text color={INK.bad} bold>✗</Text> : v === 'partial' ? <Text color={INK.warn} bold>◐</Text> : <Text dimColor bold>?</Text>
    title = <Text bold italic>{`“${item.receipt.claim.quote}”`}</Text>
    body = [<Text key="result">{item.receipt.evidence}</Text>]
    coverage = v === 'contradicted' ? 'the record contradicts this claim' : v === 'partial' ? 'the record only partly backs this claim' : 'nothing recorded this turn backs this claim'
  } else if (item.kind === 'change') {
    const lines = item.edits.flatMap((e, k) => (k ? ['…', ...e.patch] : e.patch))
    const first = item.edits[0]
    const created = item.edits.some(e => e.created)
    mark = <Text color={item.why ? INK.warn : undefined} bold>{item.why ? '⚠' : '•'}</Text>
    title = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text bold>{relativeTo(cwd, item.path)}</Text>
        {item.why ? <Text color={INK.warn}>{item.why}</Text> : null}
      </Box>
    )
    body = [
      ...(relativeTo(cwd, item.path) !== item.path ? [<Text key="path" dimColor>{item.path}</Text>] : []),
      <Text key="action" dimColor>{`${created ? 'Write created it' : `${item.edits.length} edit${item.edits.length === 1 ? '' : 's'} landed`}${first ? ` at ${clock(first.atMs)}` : ''}`}</Text>,
      <Box key="hunk" flexDirection="column" paddingLeft={1}>{diffLines(kit, lines.slice(0, HUNK_PREVIEW), `h${i}-`)}</Box>,
      ...(lines.length > HUNK_PREVIEW ? [<Text key="more" dimColor>{`… ${lines.length - HUNK_PREVIEW} more line${lines.length - HUNK_PREVIEW === 1 ? '' : 's'}`}</Text>] : []),
    ]
    coverage = item.shared ? `the summary's \`${item.shared}\` matches more than one changed file` : 'the summary never names this file'
  } else {
    mark = <Text color={INK.warn} bold>⚠</Text>
    title = <Text bold>{item.effect}</Text>
    body = [
      <Text key="action">{`$ ${item.command}`}</Text>,
      <Text key="result" color={item.ok === false ? INK.bad : undefined} dimColor={item.ok !== false}>{item.result}</Text>,
    ]
    coverage = 'the summary never mentions it'
  }

  const changeIndex = item.kind === 'change' ? changesOf(fp).indexOf(item) : -1
  return (
    <Box key={`item-${i}`} flexDirection="column" paddingLeft={1} borderStyle="single" borderColor={item.kind === 'claim' ? (item.receipt.verdict === 'contradicted' ? INK.bad : item.receipt.verdict === 'partial' ? INK.warn : 'gray') : item.kind === 'command' || (item.kind === 'change' && item.why) ? INK.warn : 'gray'}>
      <Box key="title" flexDirection="row" gap={1}>
        <Box width={2} flexShrink={0}>{mark}</Box>
        <Box flexShrink={1}>{title}</Box>
      </Box>
      <Box key="body" flexDirection="column" paddingLeft={3}>{body}</Box>
      <Box key="foot" flexDirection="row" gap={2} paddingLeft={3} flexWrap="wrap">
        <Text italic dimColor>{`Summary: ${coverage}`}</Text>
        {ask}
        {changeIndex >= 0 ? <Button key={`diff-${i}`} label="Full diff" onPress={() => act.review(changeIndex)} /> : null}
      </Box>
    </Box>
  )
}

function listView(kit: Kit, fp: FinePrint, act: Actions, cwd: string): RenderElement {
  const { Box, Text, Button } = kit
  return (
    <Box flexDirection="column">
      <Box key="head" flexDirection="column" marginBottom={1}>
        <Text bold color={fp.items.some(i => i.kind === 'claim' && i.receipt.verdict === 'contradicted') ? INK.bad : INK.warn}>{`FINE PRINT · turn ${fp.turn}`}</Text>
        <Text>{headlineOf(fp.items)}</Text>
      </Box>
      <Box key="items" flexDirection="column" gap={1}>{fp.items.map((item, i) => itemCard(kit, fp, item, i, act, cwd))}</Box>
      <Box key="actions" flexDirection="row" gap={2} marginTop={1}>
        <Button key="close" label="Close" role="dismiss" onPress={act.close} />
        <Text dimColor>Ask Claude puts one question in your prompt box. You edit it and press Enter.</Text>
      </Box>
    </Box>
  )
}

function reviewView(kit: Kit, fp: FinePrint, index: number, act: Actions, cwd: string): RenderElement {
  const { Box, Text, Button } = kit
  const changes = changesOf(fp)
  const at = Math.max(0, Math.min(index, changes.length - 1))
  const item = changes[at]
  if (!item) return listView(kit, fp, act, cwd)
  const lines = item.edits.flatMap((e, k) => (k ? ['…', ...e.patch] : e.patch))
  return (
    <Box flexDirection="column">
      <Box key="head" flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Text bold color={item.why ? INK.warn : undefined}>{`${relativeTo(cwd, item.path)}${item.why ? `  ·  ${item.why}` : ''}`}</Text>
        <Text dimColor>{`change ${at + 1} of ${changes.length}`}</Text>
      </Box>
      <Box key="diff" flexDirection="column">
        {lines.length ? diffLines(kit, lines, 'd') : <Text dimColor>The tool result recorded no diff for this change.</Text>}
      </Box>
      <Box key="actions" flexDirection="row" gap={2} marginTop={1} flexWrap="wrap">
        <Button key="prev" label="Prev" hotkey="p" onPress={() => act.step(-1)} />
        <Button key="next" label="Next" hotkey="n" onPress={() => act.step(1)} />
        <Button key="ask" label="Ask Claude" hotkey="a" variant="primary" onPress={() => act.ask(fp.items.indexOf(item))} />
        <Button key="back" label="Back" hotkey="b" onPress={act.back} />
        <Button key="close" label="Close" role="dismiss" onPress={act.close} />
      </Box>
    </Box>
  )
}

function questionView(kit: Kit, fp: FinePrint, index: number, act: Actions, cwd: string): RenderElement {
  const { Box, Text, Button } = kit
  const item = fp.items[index]
  if (!item) return listView(kit, fp, act, cwd)
  return (
    <Box flexDirection="column">
      <Text key="head" bold>The question for this item</Text>
      <Text key="why" dimColor>The prompt box could not be filled from here. Copy this into it, edit it, and press Enter.</Text>
      <Box key="question" flexDirection="column" marginTop={1} paddingLeft={1} borderStyle="single" borderColor="gray"><Text>{questionFor(item)}</Text></Box>
      <Box key="actions" flexDirection="row" gap={2} marginTop={1}>
        <Button key="back" label="Back" hotkey="b" onPress={act.back} />
        <Button key="close" label="Close" role="dismiss" onPress={act.close} />
      </Box>
    </Box>
  )
}

export function cardView(kit: Kit, fp: FinePrint | null, view: View, act: Actions, cwd = ''): RenderElement {
  const { Box, Text } = kit
  if (!fp || !fp.items.length) {
    return <Box flexDirection="column"><Text dimColor>No fine print in the last answer: it names every edit Fine Print recorded, mentions every recorded side-effect command, and no checked claim is contradicted. Fine Print reads Edit, Write, Read and Bash results from the main conversation only.</Text></Box>
  }
  if (view.mode === 'review') return reviewView(kit, fp, view.index, act, cwd)
  if (view.mode === 'question') return questionView(kit, fp, view.index, act, cwd)
  return listView(kit, fp, act, cwd)
}
