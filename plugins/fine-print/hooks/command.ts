/**
 * Reads a Bash command string just far enough to say which program a step
 * runs. Not a shell: quotes, `&&`, `||`, `;`, `|` and newlines are split; a
 * leading `VAR=x` and a few runners (`uv run`, `npx`, `python -m`) are
 * stepped through; anything else is taken literally. Pure.
 */

export type Joiner = '&&' | '||' | ';' | '|' | 'start'

export type Step = {
  /** How this step is joined to the one before it. */
  joiner: Joiner
  /** The program and its arguments, quotes removed. */
  argv: string[]
}

/** Splits a command into steps, keeping quoted text together. */
export function stepsOf(command: string): Step[] {
  const steps: Step[] = []
  let argv: string[] = []
  let word = ''
  let hasWord = false
  let joiner: Joiner = 'start'
  let quote: '"' | "'" | null = null

  const endWord = () => {
    if (hasWord) argv.push(word)
    word = ''
    hasWord = false
  }
  const endStep = (next: Joiner) => {
    endWord()
    if (argv.length) steps.push({ joiner, argv })
    argv = []
    joiner = next
  }

  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i]
      else word += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; hasWord = true; continue }
    if (c === '\\' && i + 1 < command.length) { word += command[++i]; hasWord = true; continue }
    const two = command.slice(i, i + 2)
    if (two === '&&' || two === '||') { endStep(two); i++; continue }
    if (c === ';' || c === '\n') { endStep(';'); continue }
    if (c === '|') { endStep('|'); continue }
    if (c === ' ' || c === '\t') { endWord(); continue }
    word += c
    hasWord = true
  }
  endStep(';')
  return steps
}

const RUNNERS: [string[], number][] = [
  [['uv', 'run'], 2], [['poetry', 'run'], 2], [['pipenv', 'run'], 2], [['pdm', 'run'], 2],
  [['npx'], 1], [['pnpx'], 1], [['bunx'], 1], [['pnpm', 'exec'], 2], [['yarn', 'exec'], 2],
]

/** The program a step really runs, with its arguments, after env vars and runners. */
export function programOf(argv: string[]): string[] {
  let rest = argv
  while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0] as string)) rest = rest.slice(1)
  for (;;) {
    const runner = RUNNERS.find(([words]) => words.every((w, i) => rest[i] === w))
    if (!runner) break
    rest = rest.slice(runner[1])
  }
  const head = (rest[0] ?? '').split('/').pop() ?? ''
  if (/^python(?:3(?:\.\d+)?)?$/.test(head) && rest[1] === '-m' && rest[2]) return [rest[2], ...rest.slice(3)]
  return [head, ...rest.slice(1)]
}

/**
 * The step whose exit status is the command's: the last one, and only when
 * every join before it is `&&` (each earlier step had to succeed for it to run).
 * After a `|`, `||` or `;` the status may be another program's, so null.
 */
export function decidingStep(command: string): { program: string[]; isSole: boolean } | null {
  const steps = stepsOf(command)
  const last = steps[steps.length - 1]
  if (!last) return null
  if (steps.slice(1).some(s => s.joiner !== '&&')) return null
  return { program: programOf(last.argv), isSole: steps.length === 1 }
}

/** True when any argument asks for help, a version, a dry run or a listing instead of a real run. */
export const NO_RUN_FLAGS = /^(?:--help|-h|--version|-V|--dry-run|--dryrun|--collect-only|--co|--list|--list-tests|--listTests|--showConfig|--no-run)$/

export function asksForNoRun(args: string[], extra: RegExp | null = null): boolean {
  return args.some(a => NO_RUN_FLAGS.test(a) || (extra !== null && extra.test(a)))
}
