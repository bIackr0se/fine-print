/**
 * The fine print of one turn: what actually happened that Claude's final
 * answer did not say. Pure. Built only from the turn's recorded tool calls
 * (ledger.ts) and the answer's own words; a thing the answer names is not
 * fine print, and a turn whose answer covers everything has none.
 */
import { claimsOf, filesIn } from './claims'
import { asksForNoRun, programOf, stepsOf } from './command'
import { type Receipt, receiptsOf, type ToolEvent } from './ledger'

type Edit = Extract<ToolEvent, { kind: 'edit' }>
type Shell = Extract<ToolEvent, { kind: 'shell' }>

export type Item =
  | { kind: 'claim'; receipt: Receipt }
  | { kind: 'change'; path: string; why: string | null; edits: Edit[]; shared: string | null }
  | { kind: 'command'; command: string; effect: string; ok: boolean | null; observed: boolean | null; result: string; at: number }

export type FinePrint = { turn: number; items: Item[] }

/** Paths whose silent change matters more than most, with the reason shown beside them. */
const SENSITIVE: [RegExp, string][] = [
  [/(?:^|\/)\.env(?:\.[\w.-]+)?$|(?:^|\/)(?:secrets?|credentials?)(?:\.[\w]+)?$|\.(?:pem|key|p12)$/i, 'secrets'],
  [/(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/, 'lockfile'],
  [/(?:^|\/)(?:package\.json|pyproject\.toml|requirements[\w.-]*\.txt|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/, 'dependencies'],
  [/(?:^|\/)\.github\/workflows\/|(?:^|\/)\.gitlab-ci\.yml$|(?:^|\/)\.circleci\/|(?:^|\/)Jenkinsfile$/, 'CI'],
  [/(?:^|\/)migrations?\//i, 'migration'],
  [/(?:^|\/)(?:Dockerfile|docker-compose[\w.-]*\.ya?ml|[\w.-]+\.tf)$/, 'infrastructure'],
  [/(?:^|\/)(?:auth|security|permissions?|policy)[\w.-]*\.\w+$/i, 'auth'],
]

export const sensitivityOf = (path: string): string | null => SENSITIVE.find(([re]) => re.test(path))?.[1] ?? null

/** Side effects a step can have, and the words an answer would use if it told you. */
const EFFECTS: { label: string; is: (p: string[]) => boolean; told: RegExp }[] = [
  { label: 'pushed to a remote', is: p => p[0] === 'git' && p.includes('push'), told: /\bpush(?:ed|ing)?\b/i },
  { label: 'rewrote git history or discarded work', is: p => p[0] === 'git' && (p.includes('reset') && p.includes('--hard') || p.includes('clean') || (p.includes('checkout') && p.includes('--')) || p.includes('restore') || p.includes('rebase') || p.includes('--amend') || (p.includes('stash') && p.includes('drop')) || (p.includes('branch') && p.includes('-D'))), told: /\b(?:reset|clean(?:ed)?|discard(?:ed)?|restor(?:e|ed)|rebas(?:e|ed)|amend(?:ed)?|drop(?:ped)?)\b/i },
  { label: 'deleted files', is: p => p[0] === 'rm' || p[0] === 'rmdir' || (p[0] === 'find' && p.includes('-delete')), told: /\b(?:delet(?:e|ed|ing)|remov(?:e|ed|ing)|rm)\b/i },
  { label: 'installed packages', is: p => (['npm', 'pnpm', 'yarn', 'bun'].includes(p[0] ?? '') && ['install', 'i', 'add'].includes(p[1] ?? '')) || ((p[0] === 'pip' || p[0] === 'pip3') && p[1] === 'install') || (p[0] === 'uv' && (p[1] === 'add' || (p[1] === 'pip' && p[2] === 'install'))) || (p[0] === 'poetry' && p[1] === 'add') || (p[0] === 'brew' && p[1] === 'install') || (p[0] === 'cargo' && (p[1] === 'add' || p[1] === 'install')) || (p[0] === 'go' && p[1] === 'get'), told: /\binstall(?:ed|ing)?\b|\badd(?:ed)? (?:the )?(?:package|dependency|dep)/i },
  { label: 'ran a script from the network', is: p => p[0] === 'sh' || p[0] === 'bash', told: /\binstall(?:er|ed)?\b|\bscript\b/i },
  { label: 'changed containers or clusters', is: p => (p[0] === 'docker' && ['run', 'rm', 'rmi', 'push', 'compose', 'system'].includes(p[1] ?? '')) || (p[0] === 'kubectl' && ['apply', 'delete', 'rollout', 'scale'].includes(p[1] ?? '')) || (p[0] === 'terraform' && ['apply', 'destroy'].includes(p[1] ?? '')), told: /\b(?:docker|container|kubectl|cluster|deploy(?:ed)?|terraform|appl(?:y|ied)|destroy(?:ed)?)\b/i },
  { label: 'acted on GitHub', is: p => p[0] === 'gh' && ((p[1] === 'pr' && ['create', 'merge', 'close', 'comment'].includes(p[2] ?? '')) || (p[1] === 'release' && p[2] === 'create') || (p[1] === 'issue' && ['create', 'close', 'comment'].includes(p[2] ?? '')) || (p[1] === 'repo' && p[2] === 'delete')), told: /\b(?:PR|pull request|merged|release|issue|comment(?:ed)?)\b/i },
  { label: 'ran with sudo', is: p => p[0] === 'sudo', told: /\bsudo\b/i },
]

/** File tokens an answer names: dotted names with paths, dotfiles, and anything in backticks that looks like a path. */
export function namesIn(answer: string): string[] {
  const names = new Set(filesIn(answer))
  for (const m of answer.matchAll(/`([^`\s]+)`/g)) if (/[./]/.test(m[1] ?? '')) names.add((m[1] ?? '').replace(/^\.\//, ''))
  for (const m of answer.matchAll(/(?:^|[\s(`'"])((?:[\w.@-]+\/)*\.[\w][\w.-]*)(?=[\s`'"),.:;!?]|$)/g)) names.add(m[1] ?? '')
  return [...names].filter(Boolean)
}

/** Does this answer token name this path: the whole path, or a suffix ending on a segment boundary? */
const tokenMatches = (token: string, path: string) => path === token || path.endsWith('/' + token)

/**
 * Which of the turn's changed paths the answer names, and which it names only
 * through a token that matches several of them (a bare `config.ts` for
 * src/config.ts and tests/config.ts names neither; it is reported).
 */
export function namingOf(answer: string, paths: string[]): { named: Set<string>; shared: Map<string, string> } {
  const named = new Set<string>()
  const shared = new Map<string, string>()
  for (const token of namesIn(answer)) {
    const hits = paths.filter(p => tokenMatches(token, p))
    if (hits.length === 1) named.add(hits[0] as string)
    else if (hits.length > 1) for (const h of hits) if (!shared.has(h)) shared.set(h, token)
  }
  for (const p of named) shared.delete(p)
  return { named, shared }
}

/** Does the answer name this path unambiguously among the given changed paths (default: just this one)? */
export function isNamed(answer: string, path: string, among: string[] = [path]): boolean {
  return namingOf(answer, among.includes(path) ? among : [...among, path]).named.has(path)
}

/** The text inside each top-level `$( … )` and backtick pair; null when the nesting is deeper or unbalanced. */
export function substitutionsOf(command: string): string[] | null {
  const inner: string[] = []
  let quote: "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === "'") { quote = c; continue }
    if (c === '\\') { i++; continue }
    if (c === '$' && command[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      for (; j < command.length && depth > 0; j++) {
        if (command[j] === '(') depth++
        else if (command[j] === ')') depth--
      }
      if (depth !== 0) return null
      const body = command.slice(i + 2, j - 1)
      if (body.includes('$(') || body.includes('`')) return null
      inner.push(body)
      i = j - 1
    } else if (c === '`') {
      const end = command.indexOf('`', i + 1)
      if (end < 0) return null
      inner.push(command.slice(i + 1, end))
      i = end
    }
  }
  return inner
}

function topEffectOf(command: string): string | null {
  const steps = stepsOf(command)
  const piped = steps.some((s, i) => i > 0 && s.joiner === '|' && ['sh', 'bash', 'zsh'].includes(programOf(s.argv)[0] ?? '') && ['curl', 'wget'].includes(programOf(steps[i - 1]?.argv ?? [])[0] ?? ''))
  if (piped) return 'ran a script from the network'
  for (const s of steps) {
    const p = programOf(s.argv)
    if (asksForNoRun(p.slice(1), p[0] === 'git' && p.includes('push') ? /^-n$/ : null)) continue
    const hit = EFFECTS.find(e => e.label !== 'ran a script from the network' && e.is(p))
    if (hit) return hit.label
  }
  return null
}

export const UNREADABLE = 'a command substitution Fine Print cannot read'

/** The side effect a recorded command had, reading one level of `$( … )` or backticks; UNREADABLE for deeper nesting. */
function effectOf(command: string): string | null {
  const inner = substitutionsOf(command)
  if (inner === null) return UNREADABLE
  for (const body of inner) {
    const hit = topEffectOf(body)
    if (hit) return hit
  }
  return topEffectOf(command)
}

/** For effects whose output shows them happening, whether it did; null where output cannot tell. */
const SHOWN: Record<string, RegExp> = {
  'pushed to a remote': /^To \S+[\s\S]*->/m,
  'acted on GitHub': /https?:\/\/\S+\/(?:pull|issues|releases)\/|✓ Merged|Merged pull request/,
}

function resultOf(e: Shell, effect: string): { ok: boolean | null; observed: boolean | null; result: string } {
  const ok = e.exit.kind === 'code' ? e.exit.code === 0 : null
  const exit = e.exit.kind === 'code' ? `exit ${e.exit.code}` : e.exit.kind === 'unknown' ? `no readable exit status` : e.exit.kind
  const shown = SHOWN[effect]
  const observed = ok && shown ? shown.test(e.output) : null
  const tail = e.output.split('\n').map(l => l.trim()).filter(Boolean).slice(-2).join(' ⏎ ')
  const result = observed === false ? `${exit} · the output shows no sign it happened` : `${exit}${tail ? ` · ${tail.length > 90 ? tail.slice(0, 89) + '…' : tail}` : ''}`
  return { ok, observed, result }
}

const short = (cmd: string) => (cmd.length > 60 ? cmd.slice(0, 59) + '…' : cmd)

export function finePrintOf(answer: string, events: ToolEvent[], turn: number): FinePrint {
  const items: Item[] = []
  // only what the main loop did in this turn: a subagent's work and older turns are not this answer's to name
  const now = events.filter(e => e.turn === turn && e.agentId === null)

  for (const receipt of receiptsOf(claimsOf(answer), now, turn, 'this turn')) {
    // a test or git claim with nothing behind it is fine print too (shown as unbacked, not as failed)
    const matters = receipt.verdict === 'contradicted' || (receipt.claim.kind !== 'file' && (receipt.verdict === 'partial' || receipt.verdict === 'unknown'))
    if (matters) items.push({ kind: 'claim', receipt })
  }

  const byPath = new Map<string, Edit[]>()
  for (const e of now) {
    if (e.kind !== 'edit' || !e.landed || e.path === null) continue
    byPath.set(e.path, [...(byPath.get(e.path) ?? []), e])
  }
  const changes: Item[] = []
  const { named, shared } = namingOf(answer, [...byPath.keys()])
  for (const [path, edits] of byPath) {
    if (!named.has(path)) changes.push({ kind: 'change', path, why: sensitivityOf(path), edits, shared: shared.get(path) ?? null })
  }
  changes.sort((a, b) => Number(b.kind === 'change' && b.why !== null) - Number(a.kind === 'change' && a.why !== null))
  items.push(...changes)

  for (const e of now) {
    if (e.kind !== 'shell') continue
    const effect = effectOf(e.command)
    if (!effect) continue
    const told = EFFECTS.find(x => x.label === effect)?.told
    if (effect !== UNREADABLE && told?.test(answer)) continue
    items.push({ kind: 'command', command: e.command, effect, ...resultOf(e, effect), at: e.seq })
  }

  return { turn, items }
}

const WAIT = 'Do not change or run anything yet; wait for my OK.'

/** The question for one item: what happened, why, and the smallest correction that keeps the rest of my work. */
export function questionFor(item: Item): string {
  if (item.kind === 'claim') {
    return `You said "${item.receipt.claim.quote}", but ${item.receipt.evidence}. What is actually true right now? If something needs fixing, propose the smallest fix. ${WAIT}`
  }
  if (item.kind === 'change') {
    const hunk = item.edits.flatMap(e => e.patch).slice(0, 40)
    return `This turn you ${item.edits.some(e => e.created) ? 'created' : 'changed'} \`${item.path}\`${item.why ? ` (${item.why})` : ''}, and your summary ${item.shared ? `named only \`${item.shared}\`, which matches more than one file you changed` : 'did not mention it'}.\n\`\`\`diff\n${hunk.join('\n')}\n\`\`\`\nWhy was this change needed? If it was not part of what I asked, propose the smallest correction that keeps the rest of my work. ${WAIT}`
  }
  return `This turn you ran \`${item.command}\` (${item.effect}; ${item.result}), and your summary did not mention it. Why did you run it, and what did it change? If anything needs putting right, propose the smallest correction that keeps the rest of my work. ${WAIT}`
}

export function headlineOf(items: Item[]): string {
  const n = items.length
  const claims = items.filter(i => i.kind === 'claim').length
  const sensitive = items.filter(i => i.kind === 'change' && i.why).length
  const parts = [`${n} thing${n === 1 ? '' : 's'} the summary left out`]
  if (claims) parts.push(`${claims} claim${claims === 1 ? '' : 's'} the record does not back`)
  if (sensitive) parts.push(`${sensitive} sensitive file${sensitive === 1 ? '' : 's'}`)
  return parts.join(' · ')
}
