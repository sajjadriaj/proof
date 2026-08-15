// Terminal formatting, in one place. These rules were fixed once in `check` and then found
// again, unfixed, in `infer`: a single long value padding every row past the terminal width.
// Shared so the next command to grow a column inherits the answer.

export const TERMINAL_WIDTH = 100

// CJK and fullwidth characters occupy two columns but one code unit each, so padding by
// length alone leaves non-Latin rows ragged.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/

export const displayWidth = s => [...String(s)].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0)

export const padTo = (s, width) => s + ' '.repeat(Math.max(0, width - displayWidth(s)))

/** Cut to a display width, marking the cut. Counts columns, not characters. */
export const truncateToWidth = (s, max) => {
  if (displayWidth(s) <= max) return String(s)
  let out = ''
  let width = 0
  for (const ch of String(s)) {
    const w = WIDE.test(ch) ? 2 : 1
    if (width + w > max - 1) break
    out += ch
    width += w
  }
  return `${out}…`
}

export const ellipsize = (line, width = TERMINAL_WIDTH) => {
  if (line.length <= width) return line

  // The suffix counts toward the width. Appending it after slicing to `width` made every
  // truncated line longer than the limit it was truncated to.
  const suffixFor = hidden => `… (${hidden} more character(s) on this line)`
  let cut = width
  for (let i = 0; i < 4; i++) {
    const next = Math.max(1, width - suffixFor(line.length - cut).length)
    if (next === cut) break
    cut = next
  }
  return line.slice(0, cut) + suffixFor(line.length - cut)
}

export const wrap = (s, width) => {
  const lines = []
  for (const word of String(s).split(/\s+/).filter(Boolean)) {
    // A URL can be longer than the whole width on its own, so break it rather than let it
    // overflow — greedy wrapping alone only ever moves an over-long word to its own line.
    const parts = word.length <= width ? [word] : word.match(new RegExp(`.{1,${width}}`, 'g'))
    for (const part of parts) {
      const last = lines[lines.length - 1]
      if (last && (last + ' ' + part).length <= width) lines[lines.length - 1] = `${last} ${part}`
      else lines.push(part)
    }
  }
  return lines
}

// Enough for any explanation proof writes; a bound only in case something unbounded is
// ever passed here, since program output has its own path through clip().
const MAX_BLOCK_LINES = 24

/**
 * Indent every line, not just the first: a multi-line value used to start at the indent and
 * then fall back to column zero, running into whatever section came next.
 *
 * Wraps rather than truncates. This renders the Expected/Observed prose that explains a
 * failure, and cutting it lost the part the reader needs: an occupied port reported
 * "something is already responding at http://localhost:8388 b…" and dropped the 179
 * characters saying what to do about it.
 */
export const block = (text, indent = '    ') => {
  const lines = String(text ?? '').split('\n').flatMap(line => {
    // wrap() returns nothing for an empty line, which would close up the blank lines
    // between paragraphs and run them together.
    const trimmed = line.trimEnd()
    // Only re-flow what does not fit. wrap() collapses runs of whitespace, which turns any
    // pre-formatted content — a table, or the box Playwright draws around its install
    // instructions — into ragged nonsense for no gain.
    if (displayWidth(trimmed) <= TERMINAL_WIDTH - indent.length) return [indent + trimmed]

    const parts = wrap(trimmed, TERMINAL_WIDTH - indent.length)
    return parts.length ? parts.map(l => indent + l) : [indent]
  })

  if (lines.length <= MAX_BLOCK_LINES) return lines.join('\n')
  const kept = lines.slice(0, MAX_BLOCK_LINES)
  return [...kept, `${indent}… ${lines.length - MAX_BLOCK_LINES} more line(s) …`].join('\n')
}

/** Width for a padded column of values, bounded so one long entry cannot widen the rest. */
export const columnWidth = (values, max, min = 12) =>
  values.reduce((widest, v) => Math.max(widest, displayWidth(truncateToWidth(v, max))), min)
