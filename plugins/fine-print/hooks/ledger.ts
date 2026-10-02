/**
 * The session's record of what tools actually did, and the receipts it gives
 * each claim. Pure. Reads only the result shapes recorded on Claude Code
 * 2.1.286 (demo/probe-shapes.md); any other shape is kept as `unknown` and
 * drawn as such, never guessed into a pass or a fail.
 */
import type { Claim } from './claims'
import { asksForNoRun, decidingStep, programOf, stepsOf } from './command'

export const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'] as const
export const SHELL_TOOLS = ['Bash'] as const
export const READ_TOOLS = ['Read'] as const

export type Exit =
  | { kind: 'code'; code: number }
  | { kind: 'interrupted' }
  | { kind: 'denied'; reason: string }
  | { kind: 'unknown'; reason: string }

export type ToolEvent =
  | { seq: number; turn: number; atMs: number; agentId: string | null; kind: 'edit'; path: string | null; landed: boolean; reason: string | null; created: boolean; patch: string[] }
  | { seq: number; turn: number; atMs: number; agentId: string | null; kind: 'read'; path: string | null }
  | { seq: number; turn: number; atMs: number; agentId: string | null; kind: 'shell'; command: string; exit: Exit; output: string }

type Raw = { tool: string; input: Record<string, unknown>; result: unknown }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const firstLine = (s: string) => s.split('\n')[0] ?? ''

/** The diff lines an Edit or Write result recorded: its structuredPatch hunks, or a new file's content as additions. */
export function patchOf(inner: Record<string, unknown>): string[] {
  const hunks = Array.isArray(inner.structuredPatch) ? inner.structuredPatch : []
  const lines: string[] = []
  for (const hunk of hunks) {
    if (!isRecord(hunk) || !Array.isArray(hunk.lines)) continue
    if (lines.length) lines.push('…')
    for (const l of hunk.lines) if (typeof l === 'string') lines.push(l)
  }
  if (!lines.length && inner.type === 'create' && typeof inner.content === 'string') {
    for (const l of inner.content.replace(/\n$/, '').split('\n')) lines.push('+' + l)
  }
  return lines
}

/** Turns one finished tool call into an event, by the recorded shapes only. */
export function eventOf(raw: Raw, stamp: { seq: number; turn: number; atMs: number }): ToolEvent | null {
  const agentId = typeof raw.input.agentId === 'string' ? raw.input.agentId : null
  const at = { ...stamp, agentId }
  const r = isRecord(raw.result) ? raw.result : {}
  const isError = r.isError === true
  const deny = str(r.deny)

  if ((EDIT_TOOLS as readonly string[]).includes(raw.tool)) {
    const inner = isRecord(r.result) ? r.result : null
    const path = str(inner?.filePath) ?? str(raw.input.file_path) ?? str(raw.input.notebook_path)
    if (deny !== null) return { ...at, kind: 'edit', path, landed: false, reason: `refused: ${deny}`, created: false, patch: [] }
    if (isError) return { ...at, kind: 'edit', path, landed: false, reason: firstLine(str(r.result) ?? str(r.text) ?? 'error').replace(/^Error:\s*/, ''), created: false, patch: [] }
    const landed = inner !== null && str(inner.filePath) !== null
    return { ...at, kind: 'edit', path, landed, reason: landed ? null : 'result shape not recognised', created: inner?.type === 'create', patch: inner ? patchOf(inner) : [] }
  }

  if ((READ_TOOLS as readonly string[]).includes(raw.tool)) {
    const inner = isRecord(r.result) ? r.result : null
    const file = inner && isRecord(inner.file) ? inner.file : null
    return { ...at, kind: 'read', path: str(file?.filePath) ?? str(raw.input.file_path) }
  }

  if ((SHELL_TOOLS as readonly string[]).includes(raw.tool)) {
    const command = str(raw.input.command) ?? ''
    if (deny !== null) return { ...at, kind: 'shell', command, exit: { kind: 'denied', reason: deny }, output: '' }
    if (isError) {
      const text = str(r.text) ?? ''
      const m = /^Exit code (\d+)\n?([\s\S]*)$/.exec(text)
      return m
        ? { ...at, kind: 'shell', command, exit: { kind: 'code', code: Number(m[1]) }, output: m[2] ?? '' }
        : { ...at, kind: 'shell', command, exit: { kind: 'unknown', reason: firstLine(text) || 'error without an exit code' }, output: text }
    }
    const inner = isRecord(r.result) ? r.result : null
    if (inner && typeof inner.stdout === 'string' && typeof inner.interrupted === 'boolean') {
      const output = [inner.stdout, str(inner.stderr) ?? ''].filter(Boolean).join('\n')
      return { ...at, kind: 'shell', command, exit: inner.interrupted ? { kind: 'interrupted' } : { kind: 'code', code: 0 }, output }
    }
    return { ...at, kind: 'shell', command, exit: { kind: 'unknown', reason: 'result shape not recognised' }, output: '' }
  }

  return null
}

// --- receipts ---------------------------------------------------------------

export type Verdict = 'backed' | 'contradicted' | 'partial' | 'unknown'

export type Receipt = {
  claim: Claim
  verdict: Verdict
  /** One line of evidence, as the strip draws it. */
  evidence: string
  /** The event it rests on, when there is one. */
  at: number | null
}

/** Is `program` (from programOf) a test runner, and with which arguments after the runner's own words? */
function testArgsOf(program: string[]): string[] | null {
  const [name, ...args] = program
  const sub = args[0]
  switch (name) {
    case 'pytest': case 'py.test': case 'jest': case 'vitest': case 'mocha': case 'ava': case 'tap':
    case 'tox': case 'nox': case 'rspec': case 'phpunit': case 'ctest': case 'unittest':
      return args
    case 'go': case 'swift': case 'dotnet': case 'deno': case 'bun':
      return sub === 'test' ? args.slice(1) : null
    case 'cargo':
      return sub === 'test' || sub === 'nextest' ? args.slice(sub === 'nextest' && args[1] === 'run' ? 2 : 1) : null
    case 'npm': case 'pnpm': case 'yarn':
      return sub === 'test' || sub === 't' ? args.slice(1) : sub === 'run' && args[1] === 'test' ? args.slice(2) : null
    case 'make':
      return sub === 'test' || sub === 'check' ? args.slice(1) : null
    case 'claude':
      return sub === 'plugin' && args[1] === 'test' ? args.slice(2) : null
    case 'gradle': case 'gradlew': case './gradlew': case 'mvn': case 'mvnw':
      return args.includes('test') ? args.filter(a => a !== 'test') : null
    default:
      return null
  }
}

/**
 * How a recorded command relates to running tests: `run` when the step that
 * decides the exit status is a real test run, `ambiguous` when a runner is
 * a step but another program may decide the status, `no-run` when the only
 * runner asks for help, a version, a dry run or a listing, `none` otherwise.
 */
export function testRunOf(command: string): { kind: 'run'; args: string[] } | { kind: 'ambiguous' | 'no-run' | 'none' } {
  const deciding = decidingStep(command)
  if (deciding) {
    const args = testArgsOf(deciding.program)
    if (args) return asksForNoRun(args) ? { kind: 'no-run' } : { kind: 'run', args }
  }
  const anyRunner = stepsOf(command).some(s => testArgsOf(programOf(s.argv)) !== null)
  return { kind: anyRunner ? 'ambiguous' : 'none' }
}

export const isTestCommand = (command: string) => testRunOf(command).kind === 'run'

/** Arguments that narrow a run to part of the suite: a filter flag or a path. */
const narrowing = (args: string[]) =>
  args.filter((a, i) => /^(?:-k|-m|--filter|-t|--testNamePattern|--grep|-run|--test)$/.test(a) || (/[/:]|\.(?:py|ts|tsx|js|jsx|go|rs|rb)$/.test(a) && !/^-/.test(a) && !/^(?:-k|-m|--filter|-t|--grep|-run)$/.test(args[i - 1] ?? '')))

export type Counts = { passed: number | null; failed: number | null }

/** What the runner itself printed in its summary; nulls when it printed no summary Receipts can read. Test names are never counted. */
export function countsOf(output: string): Counts {
  const unittest = /^Ran (\d+) tests? in [\d.]+s\s*$/m.exec(output)
  if (unittest) {
    if (/^OK\b/m.test(output)) return { passed: Number(unittest[1]), failed: 0 }
    const f = /^FAILED \((?:failures=(\d+))?(?:, )?(?:errors=(\d+))?/m.exec(output)
    if (f) {
      const failed = Number(f[1] ?? 0) + Number(f[2] ?? 0)
      return { passed: Number(unittest[1]) - failed, failed }
    }
  }
  const lines = output.split('\n')
  const tally = (text: string): Counts => {
    let passed: number | null = null
    let failed: number | null = null
    for (const m of text.matchAll(/(\d+)\s+(passed|passing|pass|failed|failing|fail|failures?)\b/gi)) {
      const n = Number(m[1])
      if (/^pass/i.test(m[2] ?? '')) passed = (passed ?? 0) + n
      else failed = (failed ?? 0) + n
    }
    return { passed, failed }
  }
  const lastOf = (re: RegExp) => [...lines].reverse().find(l => re.test(l))
  // bun / claude plugin test: " 42 pass" and " 0 fail" each on a line of its own
  const pass = lastOf(/^\s*\d+\s+pass(?:ed)?\s*$/i)
  const fail = lastOf(/^\s*\d+\s+fail(?:ed)?\s*$/i)
  if (pass || fail) return { passed: pass ? tally(pass).passed : null, failed: fail ? tally(fail).failed : null }
  // jest / vitest: the last "Tests:" line
  const jest = lastOf(/^\s*Tests:?\s/)
  if (jest) return tally(jest)
  // cargo: one "test result:" line per test binary
  const cargo = lines.filter(l => /^test result:/.test(l))
  if (cargo.length) return tally(cargo.join('\n'))
  // otherwise the last line that carries a count (pytest's closing "=== 3 failed, 9 passed in 0.4s ===")
  const last = lastOf(/\d+\s+(?:passed|passing|failed|failing)\b/i)
  return last ? tally(last) : { passed: null, failed: null }
}

const pad = (n: number) => String(n).padStart(2, '0')
/** Wall-clock time in the session's own time zone. */
const clock = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }
const short = (cmd: string) => (cmd.length > 48 ? cmd.slice(0, 47) + '…' : cmd)
const base = (p: string | null) => (p ?? '?').split('/').pop() ?? '?'
type Shell = Extract<ToolEvent, { kind: 'shell' }>
type Edit = Extract<ToolEvent, { kind: 'edit' }>

const pathMatches = (path: string | null, name: string) =>
  path !== null && (path === name || path.endsWith('/' + name))

function exitProblem(run: Shell): Receipt['verdict'] | null {
  return run.exit.kind === 'code' ? null : run.exit.kind === 'unknown' ? 'unknown' : 'contradicted'
}
function exitWords(run: Shell): string {
  switch (run.exit.kind) {
    case 'interrupted': return 'was interrupted'
    case 'denied': return `was refused (${run.exit.reason})`
    case 'unknown': return `ended with no readable exit status (${run.exit.reason})`
    case 'code': return `exited ${run.exit.code}`
  }
}

function testReceipt(claim: Extract<Claim, { kind: 'tests' }>, events: ToolEvent[], turn: number): Receipt {
  const shells = events.filter((e): e is Shell => e.kind === 'shell')
  const runs = shells.filter(e => { const k = testRunOf(e.command).kind; return k === 'run' || k === 'ambiguous' })
  const run = runs[runs.length - 1]
  if (!run) {
    const onlyNoRun = shells.some(e => testRunOf(e.command).kind === 'no-run')
    // nothing recorded is missing evidence, not an observed failure
    return { claim, verdict: 'unknown', evidence: `no test run was recorded in this session${onlyNoRun ? ' (only help, a dry run or a listing)' : ''}`, at: null }
  }
  const what = `\`${short(run.command)}\` at ${clock(run.atMs)}`
  const shape = testRunOf(run.command)
  if (shape.kind !== 'run') {
    return { claim, verdict: 'unknown', evidence: `${what} is a compound command; its exit status may be another program's`, at: run.seq }
  }
  const problem = exitProblem(run)
  if (problem) return { claim, verdict: problem, evidence: `${what} ${exitWords(run)}`, at: run.seq }

  const counts = countsOf(run.output)
  const tally = [counts.passed !== null && `${counts.passed} passed`, counts.failed !== null && `${counts.failed} failed`].filter(Boolean).join(', ')
  if (run.exit.kind === 'code' && run.exit.code !== 0) {
    return { claim, verdict: 'contradicted', evidence: `${what} exited ${run.exit.code}${tally ? ` · ${tally}` : ''}`, at: run.seq }
  }
  const partial = (why: string): Receipt => ({ claim, verdict: 'partial', evidence: `${what} exited 0, ${why}`, at: run.seq })
  if ((counts.failed ?? 0) > 0) return partial(`but printed ${tally}`)
  if (counts.passed === null) return partial('but printed no result line Receipts can read')
  if (claim.count !== null && claim.count !== counts.passed) return partial(`printed ${counts.passed} passed; the claim says ${claim.count}`)
  if (run.turn !== turn) return partial(`${tally}, in an earlier turn`)
  const later = events.filter((e): e is Edit => e.kind === 'edit' && e.landed && e.seq > run.seq)
  if (later.length) {
    const names = [...new Set(later.map(e => base(e.path)))]
    return partial(`${tally}, then ${later.length} edit${later.length === 1 ? '' : 's'} landed after it (${names.join(', ')})`)
  }
  const narrowed = narrowing(shape.args)
  if (narrowed.length && /\ball\b/i.test(claim.quote)) return partial(`${tally}, but the run was narrowed (${narrowed.join(' ')}) and the claim says all`)
  return { claim, verdict: 'backed', evidence: `${what} exited 0 · ${tally}`, at: run.seq }
}

function fileReceipt(claim: Extract<Claim, { kind: 'file' }>, events: ToolEvent[], turn: number): Receipt {
  const edits = events.filter((e): e is Edit => e.kind === 'edit' && pathMatches(e.path, claim.name))
  const landed = edits.filter(e => e.landed)
  const last = edits[edits.length - 1]
  const paths = [...new Set(landed.map(e => e.path))]
  if (paths.length > 1) {
    return { claim, verdict: 'partial', evidence: `edits landed on ${paths.length} different files with this name: ${paths.join(', ')}`, at: landed[landed.length - 1]?.seq ?? null }
  }
  if (last && !last.landed && landed.length) {
    return { claim, verdict: 'partial', evidence: `an earlier edit landed, but the last one at ${clock(last.atMs)} did not: ${last.reason ?? 'unknown reason'}`, at: last.seq }
  }
  const lastLanded = landed[landed.length - 1]
  if (lastLanded) {
    const where = lastLanded.turn === turn ? '' : ', in an earlier turn'
    return { claim, verdict: 'backed', evidence: `edit landed at ${clock(lastLanded.atMs)}${where}${landed.length > 1 ? ` (${landed.length} edits)` : ''}`, at: lastLanded.seq }
  }
  if (last) return { claim, verdict: 'contradicted', evidence: `the edit did not land: ${last.reason ?? 'unknown reason'}`, at: last.seq }
  const name = claim.name.split('/').pop() ?? claim.name
  const shell = [...events].reverse().find((e): e is Shell => e.kind === 'shell' && e.command.includes(name))
  if (shell) return { claim, verdict: 'unknown', evidence: `no edit tool touched it; only a shell command named it (\`${short(shell.command)}\`)`, at: shell.seq }
  const read = events.some(e => e.kind === 'read' && pathMatches(e.path, claim.name))
  return { claim, verdict: 'contradicted', evidence: read ? 'read, but never edited in this session' : 'no edit to this file in this session', at: null }
}

type GitAction = Extract<Claim, { kind: 'git' }>['action']

const GIT_LABEL: Record<GitAction, string> = { commit: 'git commit', push: 'git push', pr: 'gh pr create', merge: 'merge' }

/** What a successful run prints when the action really happened. */
const GIT_EFFECT: Record<GitAction, RegExp> = {
  commit: /^\[[^\]\n]+ [0-9a-f]{7,40}\]/m,
  push: /^To \S+[\s\S]*->/m,
  pr: /https?:\/\/\S+\/pull\/\d+/,
  merge: /Merged pull request|✓ Merged|Fast-forward|Merge made by/,
}

const GIT_NO_RUN: Record<GitAction, RegExp | null> = { commit: null, push: /^-n$/, pr: null, merge: null }

function gitStepOf(program: string[], action: GitAction): string[] | null {
  const [name, ...args] = program
  if (name === 'gh') {
    if (args[0] !== 'pr') return null
    return (action === 'pr' && args[1] === 'create') || (action === 'merge' && args[1] === 'merge') ? args.slice(2) : null
  }
  if (name !== 'git') return null
  let i = 0
  while (i < args.length && /^-/.test(args[i] as string)) i += /^-(?:C|c)$/.test(args[i] as string) ? 2 : 1
  const sub = args[i]
  return (action === 'commit' && sub === 'commit') || (action === 'push' && sub === 'push') || (action === 'merge' && sub === 'merge') ? args.slice(i + 1) : null
}

export function gitRunOf(command: string, action: GitAction): { kind: 'run' } | { kind: 'ambiguous' | 'no-run' | 'none' } {
  const deciding = decidingStep(command)
  if (deciding) {
    const args = gitStepOf(deciding.program, action)
    if (args) return asksForNoRun(args, GIT_NO_RUN[action]) ? { kind: 'no-run' } : { kind: 'run' }
  }
  return { kind: stepsOf(command).some(s => gitStepOf(programOf(s.argv), action) !== null) ? 'ambiguous' : 'none' }
}

function gitReceipt(claim: Extract<Claim, { kind: 'git' }>, events: ToolEvent[]): Receipt {
  const shells = events.filter((e): e is Shell => e.kind === 'shell')
  const runs = shells.filter(e => { const k = gitRunOf(e.command, claim.action).kind; return k === 'run' || k === 'ambiguous' })
  const run = runs[runs.length - 1]
  const label = GIT_LABEL[claim.action]
  if (!run) {
    const onlyNoRun = shells.some(e => gitRunOf(e.command, claim.action).kind === 'no-run')
    // nothing recorded is missing evidence, not an observed failure
    return { claim, verdict: 'unknown', evidence: `no ${label} was recorded in this session${onlyNoRun ? ' (only help or a dry run)' : ''}`, at: null }
  }
  const what = `\`${short(run.command)}\` at ${clock(run.atMs)}`
  if (gitRunOf(run.command, claim.action).kind !== 'run') {
    return { claim, verdict: 'unknown', evidence: `${what} is a compound command; its exit status may be another program's`, at: run.seq }
  }
  const problem = exitProblem(run)
  if (problem) return { claim, verdict: problem, evidence: `${what} ${exitWords(run)}`, at: run.seq }
  if (run.exit.kind === 'code' && run.exit.code !== 0) return { claim, verdict: 'contradicted', evidence: `${what} exited ${run.exit.code}`, at: run.seq }
  return GIT_EFFECT[claim.action].test(run.output)
    ? { claim, verdict: 'backed', evidence: `${what} exited 0 and printed the ${claim.action === 'pr' ? 'PR link' : claim.action === 'commit' ? 'new commit' : claim.action === 'push' ? 'pushed ref' : 'merge'}`, at: run.seq }
    : { claim, verdict: 'partial', evidence: `${what} exited 0, but printed no sign of the ${claim.action === 'pr' ? 'PR' : claim.action}`, at: run.seq }
}

/**
 * Each claim's receipt over the given events. `scope` names what those events
 * cover in the evidence text ('this session' by default; Fine Print passes
 * only the turn's own main-loop events and 'this turn').
 */
export function receiptsOf(claims: Claim[], events: ToolEvent[], turn: number, scope = 'this session'): Receipt[] {
  return claims.map(claim => {
    const r = claim.kind === 'tests' ? testReceipt(claim, events, turn)
      : claim.kind === 'file' ? fileReceipt(claim, events, turn)
        : gitReceipt(claim, events)
    return scope === 'this session' ? r : { ...r, evidence: r.evidence.replace(/in this session/g, `in ${scope}`) }
  })
}

export function tallyOf(receipts: Receipt[]): Record<Verdict, number> {
  const t: Record<Verdict, number> = { backed: 0, contradicted: 0, partial: 0, unknown: 0 }
  for (const r of receipts) t[r.verdict] += 1
  return t
}
