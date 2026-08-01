export type TokenKind =
  | 'keyword'
  | 'type'
  | 'string'
  | 'number'
  | 'comment'
  | 'ident'
  | 'punct'
  | 'plain'

export interface HighlightToken {
  text: string
  kind: TokenKind
}

const KEYWORDS: ReadonlySet<string> = new Set([
  'public',
  'private',
  'protected',
  'static',
  'readonly',
  'async',
  'await',
  'new',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'class',
  'interface',
  'extends',
  'implements',
  'export',
  'import',
  'from',
  'const',
  'let',
  'var',
  'function',
  'this',
  'throw',
  'try',
  'catch',
  'finally',
  'null',
  'undefined',
  'true',
  'false',
  'void',
  'get',
  'set',
  'in',
  'of',
  'as',
  'typeof',
  'delete',
  'default',
  'yield',
  'instanceof',
])

const TYPE_WORDS: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'any',
  'unknown',
  'never',
  'object',
  'bigint',
  'symbol',
  'Date',
  'Promise',
  'Map',
  'Set',
  'Array',
  'Record',
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
])

const PUNCT: ReadonlySet<string> = new Set([
  ':',
  ';',
  ',',
  '.',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '<',
  '>',
  '=',
  '!',
  '?',
  '+',
  '-',
  '*',
  '/',
  '&',
  '|',
  '^',
  '%',
  '@',
  '#',
  '$',
  '~',
])

const DIGIT = /[0-9]/
const HEX = /[0-9a-fA-F]/
const IDENT_START = /[A-Za-z_$]/
const IDENT_CHAR = /[A-Za-z0-9_$]/

function isIdentStart(c: string): boolean {
  return IDENT_START.test(c)
}

function isIdentChar(c: string): boolean {
  return IDENT_CHAR.test(c)
}

function isPascal(word: string): boolean {
  return word.length > 0 && /^[A-Z]/.test(word)
}

/** True when `c` at `index` can begin one of the recognized token kinds. */
function canStartToken(text: string, index: number): boolean {
  const c = text[index]
  if (PUNCT.has(c)) return true
  if (c === "'" || c === '"' || c === '`') return true
  if (isIdentStart(c) || DIGIT.test(c)) return true
  return false
}

/**
 * Regex-scanner tokenizer for TS-like signature/logic text.
 * Token texts concatenate back to the exact input.
 */
export function tokenize(text: string): HighlightToken[] {
  const tokens: HighlightToken[] = []
  let i = 0
  const len = text.length
  while (i < len) {
    const c = text[i]

    if (c === '/' && text[i + 1] === '/') {
      const start = i
      i += 2
      while (i < len && text[i] !== '\n') i++
      tokens.push({ text: text.slice(start, i), kind: 'comment' })
      continue
    }

    if (c === "'" || c === '"' || c === '`') {
      const start = i
      const quote = c
      i++
      while (i < len) {
        const ch = text[i]
        if (ch === '\\' && i + 1 < len) {
          i += 2
          continue
        }
        i++
        if (ch === quote) break
      }
      tokens.push({ text: text.slice(start, i), kind: 'string' })
      continue
    }

    if (DIGIT.test(c) || (c === '.' && DIGIT.test(text[i + 1] ?? ''))) {
      const start = i
      if (c === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
        i += 2
        while (i < len && HEX.test(text[i])) i++
      } else {
        if (c === '.') i++
        while (i < len && DIGIT.test(text[i])) i++
        if (text[i] === '.' && DIGIT.test(text[i + 1] ?? '')) {
          i++
          while (i < len && DIGIT.test(text[i])) i++
        }
        if (text[i] === 'e' || text[i] === 'E') {
          let j = i + 1
          if (text[j] === '+' || text[j] === '-') j++
          if (DIGIT.test(text[j] ?? '')) {
            i = j
            while (i < len && DIGIT.test(text[i])) i++
          }
        }
      }
      tokens.push({ text: text.slice(start, i), kind: 'number' })
      continue
    }

    if (isIdentStart(c)) {
      const start = i
      i++
      while (i < len && isIdentChar(text[i])) i++
      const word = text.slice(start, i)
      let kind: HighlightToken['kind']
      if (KEYWORDS.has(word)) {
        kind = 'keyword'
      } else if (TYPE_WORDS.has(word) || isPascal(word)) {
        kind = 'type'
      } else {
        kind = 'ident'
      }
      tokens.push({ text: word, kind })
      continue
    }

    if (c === '-' && text[i + 1] === '>') {
      tokens.push({ text: '->', kind: 'punct' })
      i += 2
      continue
    }
    if (c === '=' && text[i + 1] === '>') {
      tokens.push({ text: '=>', kind: 'punct' })
      i += 2
      continue
    }

    if (PUNCT.has(c)) {
      tokens.push({ text: c, kind: 'punct' })
      i++
      continue
    }

    const start = i
    i++
    while (i < len && !canStartToken(text, i)) i++
    tokens.push({ text: text.slice(start, i), kind: 'plain' })
  }
  return tokens
}
