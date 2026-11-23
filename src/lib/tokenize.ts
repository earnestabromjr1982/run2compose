/**
 * Shell-like tokenizer.
 *
 * Handles single quotes (literal), double quotes (backslash escapes for
 * $ ` " \ and newlines), backslash escapes outside quotes (including
 * backslash-newline continuations), and does not split words on glob chars.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let started = false
  let i = 0

  const push = () => {
    if (started) tokens.push(cur)
    cur = ''
    started = false
  }

  while (i < input.length) {
    const c = input[i]

    if (c === "'") {
      started = true
      const end = input.indexOf("'", i + 1)
      if (end === -1) {
        // Unterminated quote: take the rest literally.
        cur += input.slice(i + 1)
        i = input.length
      } else {
        cur += input.slice(i + 1, end)
        i = end + 1
      }
      continue
    }

    if (c === '"') {
      started = true
      i++
      let closed = false
      while (i < input.length) {
        const d = input[i]
        if (d === '\\' && i + 1 < input.length) {
          const n = input[i + 1]
          if ('$`"\\\n'.includes(n)) {
            if (n !== '\n') cur += n
            i += 2
            continue
          }
          cur += d
          i++
          continue
        }
        if (d === '"') {
          closed = true
          i++
          break
        }
        cur += d
        i++
      }
      if (!closed) i = input.length
      continue
    }

    if (c === '\\' && i + 1 < input.length) {
      const n = input[i + 1]
      if (n === '\n') {
        i += 2
        continue
      } // line continuation: drop both
      started = true
      cur += n
      i += 2
      continue
    }

    if (c === '\\' && i + 1 === input.length) {
      i++ // trailing lone backslash: ignore
      continue
    }

    if (/\s/.test(c)) {
      push()
      i++
      continue
    }

    started = true
    cur += c
    i++
  }

  push()
  return tokens
}

/**
 * Splits raw user input into individual `docker run …` command strings.
 *
 * Splits on newlines that are not escaped with a trailing backslash, and on
 * `&&` / `||` / `;` operators outside quotes. Strips an optional leading `$ `.
 */
export function splitCommands(input: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quote: "'" | '"' | null = null
  let i = 0
  let empty = true // nothing meaningful in `cur` yet

  const flush = () => {
    const trimmed = cur.trim().replace(/\\$/, '')
    const cleaned = trimmed.startsWith('$ ') ? trimmed.slice(2) : trimmed
    if (cleaned.length > 0) parts.push(cleaned)
    cur = ''
    empty = true
  }

  while (i < input.length) {
    const c = input[i]

    if (quote) {
      cur += c
      if (c === quote) quote = null
      i++
      continue
    }

    if (c === "'") {
      quote = c
      cur += c
      empty = false
      i++
      continue
    }

    if (c === '"') {
      quote = c
      cur += c
      empty = false
      i++
      continue
    }

    if (c === '\\' && input[i + 1] === '\n') {
      i += 2
      continue // line continuation: join the two lines
    }

    if (c === '\n') {
      flush()
      i++
      continue
    }

    if (c === ';') {
      flush()
      i++
      continue
    }

    if ((c === '&' && input[i + 1] === '&') || (c === '|' && input[i + 1] === '|')) {
      flush()
      i += 2
      continue
    }

    if (c === '#' && empty) {
      // Comment: skip to end of line.
      while (i < input.length && input[i] !== '\n') i++
      continue
    }

    if (!/\s/.test(c)) empty = false
    cur += c
    i++
  }
  flush()
  return parts
}
