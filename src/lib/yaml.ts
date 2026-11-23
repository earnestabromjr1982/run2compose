/**
 * Minimal YAML emitter for the subset we produce (nested maps, lists, scalars).
 *
 * Scalars are single-quoted whenever plain style would be ambiguous — e.g.
 * values that parse as numbers/booleans/null, start with YAML indicator chars,
 * or contain ": ", " #", or trailing ":". Multi-line strings use block literals.
 */

function looksLikeNumber(s: string): boolean {
  return /^[-+]?(\d+|(\d+\.\d*|\.\d+)([eE][-+]?\d+)?|\d+[eE][-+]?\d+)$/.test(s) || /^0[xXOo][0-9a-fA-Fo]+$/.test(s)
}

const YAML_BOOLS = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', '~', 'null…'])

export function needsQuoting(s: string): boolean {
  if (s === '') return true
  if (/^\s|\s$/.test(s)) return true
  if (s.includes('\n')) return true
  if (/^[-?:,[]{}#&*!|>'"%@`]/.test(s)) return true
  if (/:$/.test(s)) return true
  if (s.includes(': ')) return true
  if (s.includes(' #')) return true
  const lower = s.toLowerCase()
  if (YAML_BOOLS.has(lower)) return true
  if (looksLikeNumber(s)) return true
  return false
}

/** Map values like `MYSQL_ROOT_PASSWORD: "007"` must survive round-trip. */
function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function scalar(value: string): string {
  return needsQuoting(value) ? quote(value) : value
}

function blockLiteral(value: string, indent: number): string {
  const pad = ' '.repeat(indent)
  const lines = value.replace(/\n$/, '').split('\n')
  const header = value.endsWith('\n') ? '|' : '|-'
  return [header, ...lines.map((l) => (l === '' ? '' : pad + l))].join('\n') + '\n'
}

function emitValue(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent)
  if (value === null || value === undefined) return 'null\n'
  if (typeof value === 'boolean') return `${value}\n`
  if (typeof value === 'number') return `${value}\n`
  if (typeof value === 'string') {
    if (value.includes('\n')) return blockLiteral(value, indent)
    return scalar(value) + '\n'
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `[]\n`
    let out = ''
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        const body = emitMap(item as Record<string, unknown>, indent + 2)
        out += `${pad}-\n${body}`
      } else {
        out += `${pad}- ${inlineScalar(item)}\n`
      }
    }
    return out
  }
  if (typeof value === 'object') {
    return emitMap(value as Record<string, unknown>, indent)
  }
  return `${String(value)}\n`
}

function inlineScalar(value: unknown): string {
  if (value === null || value === undefined || value === '') return `''`
  if (typeof value === 'string') return scalar(value)
  return String(value)
}

function emitMap(obj: Record<string, unknown>, indent: number): string {
  const pad = ' '.repeat(indent)
  let out = ''
  const entries = Object.entries(obj)
  if (entries.length === 0) return `${pad}{}\n`
  for (const [key, value] of entries) {
    const keyStr = /^[a-zA-Z0-9_-]([a-zA-Z0-9_.-]*[a-zA-Z0-9_-])?$/.test(key) ? key : quote(key)
    const v = value ?? null
    if (typeof v === 'object' && v !== null && Object.keys(v).length === 0) {
      out += `${pad}${keyStr}: {}\n`
      continue
    }
    if (Array.isArray(v) && v.length === 0) {
      out += `${pad}${keyStr}: []\n`
      continue
    }
    if (v !== null && typeof v === 'object') {
      out += `${pad}${keyStr}:\n${emitValue(v, indent + 2)}`
      continue
    }
    out += `${pad}${keyStr}: ${emitValue(v, 0)}`
  }
  return out
}

export function toYaml(root: { services: Record<string, Record<string, unknown>>; networks?: Record<string, unknown> }): string {
  let out = ''
  out += 'services:\n'
  const names = Object.keys(root.services)
  if (names.length === 0) out += '  {}\n'
  for (const name of names) {
    out += `  ${/^[a-zA-Z0-9_-]+$/.test(name) ? name : quote(name)}:\n`
    out += emitMap(root.services[name], 4)
  }
  const netNames = Object.keys(root.networks ?? {})
  if (netNames.length > 0) {
    out += 'networks:\n'
    out += emitMap(root.networks as Record<string, unknown>, 2)
  }
  return out
}
