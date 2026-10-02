/**
 * Finds the few claims in Claude's final answer that the session's own tool
 * calls can settle: tests passing, a file changed, a commit / push / PR.
 * Pure. Deliberately narrow: a sentence that is negated, conditional or
 * about the future makes no claim, and anything else is left alone.
 */

export type GitAction = 'commit' | 'push' | 'pr' | 'merge'

export type Claim =
  | { kind: 'tests'; quote: string; count: number | null }
  | { kind: 'file'; quote: string; name: string }
  | { kind: 'git'; quote: string; action: GitAction }

const NEGATED = /\b(?:not|never|unable|skipped|cannot)\b|n't\b/i
const HEDGED = /\b(?:should|will|would|might|may|could|if|once|expect(?:ed|s)?|try|trying|need(?:s|ed)? to|want(?:s|ed)? to)\b/i

const TESTS = [
  /\b(?:all\s+)?(?:(\d+)\s+)?(?:(?:unit|integration|e2e|end-to-end|regression)\s+)?tests?\s+(?:now\s+|still\s+)?(?:pass(?:es|ed)?|are\s+(?:passing|green)|succeed(?:s|ed)?|went\s+green|are\s+all\s+passing)\b/i,
  /\btest\s+suite\s+(?:now\s+)?(?:passes|passed|is\s+(?:green|passing))\b/i,
  /\b(\d+)\s*(?:\/\s*\d+\s*)?(?:tests?\s+)?passed\b/i,
]

const CHANGE = /\b(?:updated|changed|edited|modified|added|created|fixed|wrote|rewrote|renamed|removed|deleted|refactored|moved|patched|implemented|replaced)\b/i

const GIT: [RegExp, GitAction][] = [
  [/\bcommitted\b/i, 'commit'],
  [/\bpushed\b/i, 'push'],
  [/\b(?:opened|created|raised)\s+(?:a\s+|the\s+)?(?:pr|pull\s+request)\b/i, 'pr'],
  [/\bmerged\s+(?:a\s+|the\s+|it\b|this\b)?(?:pr|pull\s+request|branch)?/i, 'merge'],
]

/** File-like tokens: a dotted name with a lettered extension, optionally with a path. */
const FILE = /(?:^|[\s(`'"])((?:[\w.@-]+\/)*[\w@-][\w.@-]*\.[a-z][a-z0-9]{0,6})(?=[\s`'"),.:;!?]|$)/gi
const NOT_FILES = /^(?:e\.g|i\.e|etc|vs|v\d|node\.js|next\.js|vue\.js|react\.js)$|\.(?:com|org|net|io|dev|ai|app|co)$/i

/** Words that mark a double-quoted span as someone else's words (reported speech), not the answer's own claim. */
const FRAMING = /\b(?:said|says|say|saying|wrote|writes|reads|read|claim(?:s|ed)?|answer(?:ed)?|summary|message|reply|replied|line|text|caption|callout|title|tagline|headline|dialogue|quot(?:e|es|ed|ing)|example|e\.g\.|such as|like|called|labell?ed|shows?|displays?|prints?|outputs?)\b[^"“.!?\n]{0,40}\s*$/i

/**
 * Blanks the inside of double-quoted spans ("…" or “…”) that the text frames as
 * reported speech: a framing word in the same sentence before the quote (`said`,
 * `reads`, `the answer`, `for example`, …). A colon alone is not framing:
 * `Tests: "All 12 tests pass."` is the answer's own claim. The answer quoting a
 * line is describing it, not claiming it. An unframed quote is left as written,
 * so a claim quoted for emphasis is still checked. Lengths are kept, so nothing
 * else shifts.
 */
export function maskReportedSpeech(text: string): string {
  return text.replace(/(["“])([^"“”\n]{1,600}?)(["”])/g, (whole, open: string, inner: string, close: string, at: number) => {
    const before = text.slice(0, at)
    const sentenceStart = Math.max(before.lastIndexOf('\n'), before.search(/[.!?]\s+[^.!?]*$/))
    const lead = before.slice(sentenceStart + 1)
    return FRAMING.test(lead) ? open + ' '.repeat(inner.length) + close : whole
  })
}

export function sentencesOf(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z`*(\-])/)
    .map(s => s.replace(/^\s*(?:[-*•]|\d+\.)\s+/, '').trim())
    .filter(s => s !== '')
}

function makesClaim(sentence: string): boolean {
  return !NEGATED.test(sentence) && !HEDGED.test(sentence)
}

export function filesIn(sentence: string): string[] {
  const names = new Set<string>()
  for (const m of sentence.matchAll(FILE)) {
    const name = (m[1] ?? '').replace(/^\.\//, '')
    if (name && !NOT_FILES.test(name) && !/^\d+(?:\.\d+)+$/.test(name)) names.add(name)
  }
  return [...names]
}

export function claimsOf(answer: string): Claim[] {
  const claims: Claim[] = []
  const seenFiles = new Set<string>()
  const seenGit = new Set<GitAction>()
  let sawTests = false

  for (const sentence of sentencesOf(maskReportedSpeech(answer))) {
    if (!makesClaim(sentence)) continue
    const plain = sentence.replace(/(["“])\s+(["”])/g, '$1…$2').replace(/\s{2,}/g, ' ')
    const quote = plain.length > 160 ? plain.slice(0, 157) + '…' : plain

    if (!sawTests) {
      for (const re of TESTS) {
        const m = re.exec(sentence)
        if (m) {
          const n = m[1] !== undefined ? Number(m[1]) : null
          claims.push({ kind: 'tests', quote, count: n })
          sawTests = true
          break
        }
      }
    }

    if (CHANGE.test(sentence)) {
      for (const name of filesIn(sentence)) {
        if (seenFiles.has(name)) continue
        seenFiles.add(name)
        claims.push({ kind: 'file', quote, name })
      }
    }

    for (const [re, action] of GIT) {
      if (!seenGit.has(action) && re.test(sentence)) {
        seenGit.add(action)
        claims.push({ kind: 'git', quote, action })
      }
    }
  }
  return claims
}
