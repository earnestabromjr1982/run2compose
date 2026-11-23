import type { RunConfig } from './parseRun'
import { parseRun } from './parseRun'
import { splitCommands } from './tokenize'
import { toYaml } from './yaml'

/** A single rendered service entry keeps insertion order for the emitter. */
export type Service = Record<string, unknown>

export interface ConversionResult {
  services: Record<string, Service>
  yaml: string
  warnings: string[]
  errors: string[]
  /** top-level network declarations the generated YAML includes */
  networks: Record<string, unknown>
}

/** Canonical key order for readability, matching `docker compose config`. */
const KEY_ORDER = [
  'image',
  'container_name',
  'hostname',
  'user',
  'working_dir',
  'entrypoint',
  'command',
  'pull_policy',
  'expose',
  'ports',
  'volumes',
  'environment',
  'env_file',
  'networks',
  'network_mode',
  'network_mode.',   // pseudo: aliases live inside networks
  'restart',
  'tty',
  'stdin_open',
  'privileged',
  'devices',
  'cap_add',
  'cap_drop',
  'security_opt',
  'group_add',
  'read_only',
  'healthcheck',
  'logging',
  'ulimits',
  'dns',
  'dns_search',
  'dns_opt',
  'extra_hosts',
  'labels',
  'init',
  'tmpfs',
  'mem_limit',
  'memswap_limit',
  'memory_reservation',
  'mem_limit.',
  'cpus',
  'cpu_shares',
  'cpuset',
  'shm_size',
  'stop_signal',
  'stop_grace_period',
  'pid',
  'userns_mode',
  'mac_address',
  'runtime',
  'isolation',
  'sysctls',
  'depends_on',
]

function keyRank(key: string): number {
  // 'network_mode.' style pseudo keys rank by their prefix
  let best = -1
  for (let i = 0; i < KEY_ORDER.length; i++) {
    if (KEY_ORDER[i].endsWith('.') ? key.startsWith(KEY_ORDER[i].slice(0, -1)) : key === KEY_ORDER[i]) {
      best = i
    }
  }
  return best === -1 ? KEY_ORDER.length : best
}

function sortServiceKeys(svc: Service): Service {
  const entries = Object.entries(svc).sort((a, b) => keyRank(a[0]) - keyRank(b[0]))
  return Object.fromEntries(entries)
}

/** Does the volume source look like a bind mount (path) or a named volume? */
export function isBindSource(source: string): boolean {
  if (source.startsWith('/') || source.startsWith('.')) return true
  if (source.startsWith('~')) return true
  // Windows drive letters like C:/ or C:\
  return /^[A-Za-z]:[/\\]/.test(source)
}

function mountToCompose(mount: string): { src: string; dst: string; ro: boolean; bind: boolean } | null {
  // --mount key=value[,key=value…] — we care about source/src, target/dst, readonly
  const parts: Record<string, string> = {}
  for (const seg of mount.split(',')) {
    const eq = seg.indexOf('=')
    if (eq === -1) parts[seg] = ''
    else parts[seg.slice(0, eq)] = seg.slice(eq + 1)
  }
  const src = parts.source ?? parts.src
  const dst = parts.target ?? parts.dst ?? parts.destination
  if (!dst) return null
  const bind = (parts.type ?? 'volume') === 'bind'
  return { src, dst, ro: 'readonly' in parts || parts.ro === 'true', bind }
}

interface ComposeVolume {
  src: string
  dst: string
  mode?: string
  bind: boolean
}

/**
 * Splits a short `-v` volume spec into source/target/mode.
 *
 * Docker only ever separates these three with colons, but Windows binds like
 * `C:\data:/app:data` sneak an extra colon into the host path, so a drive
 * letter gets special handling. An anonymous volume has no source at all.
 */
function parseShortVolume(spec: string): ComposeVolume | null {
  const specTrimmed = spec.trim()
  if (!specTrimmed) return null

  // Windows drive-letter source: glue the first two colon fields back together.
  const driveMatch = specTrimmed.match(/^([A-Za-z]):([^:]*)/)
  if (driveMatch) {
    const after = specTrimmed.slice(driveMatch[0].length)
    const parts = ['C:' + driveMatch[2], ...after.split(':').filter((s) => s !== '')]
    const last = parts[parts.length - 1]
    const mode = /^\s*([a-z]+[a-z,]*)\s*$/.test(last) ? parts.pop() : undefined
    if (parts.length === 1) return { src: '', dst: specTrimmed, bind: false }
    const src = `${parts[0]}`
    const dst = parts[1]
    return { src, dst, mode, bind: isBindSource(src) }
  }

  const fields = specTrimmed.split(':').filter((s) => s !== '')
  if (fields.length === 0) return null
  const last = fields[fields.length - 1]
  const looksLikeMode = fields.length >= 3 && /^[a-z]+([a-z,]*)$/.test(last) && last.length <= 6
  const mode = looksLikeMode ? fields.pop() : undefined
  if (fields.length === 1) return { src: '', dst: fields[0], bind: false }
  const [src, dst] = fields
  if (!dst) return null
  return { src, dst, mode, bind: isBindSource(src) }
}

function shellSplit(value: string): string[] {
  // lightweight word split honoring quotes, for --health-cmd etc.
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (q) {
      if (c === q) q = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      q = c
      cur = cur // external quotes dropped; leading word still counts
      continue
    }
    if (/\s/.test(c)) {
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

function restartToCompose(value: string): unknown {
  const v = value.trim()
  if (v === 'no' || v === '') return 'no'
  const [policy, max] = v.split(':')
  if (policy === 'on-failure' && max !== undefined) {
    const n = parseInt(max, 10)
    if (!Number.isNaN(n)) return { condition: 'on-failure', max_attempts: n }
  }
  return v
}

function envToRecord(entries: string[]): Record<string, string | null> | null {
  if (entries.length === 0) return null
  const out: Record<string, string | null> = {}
  for (const e of entries) {
    const eq = e.indexOf('=')
    if (eq === -1) out[e] = null // compose passes the value through from the host env
    else out[e.slice(0, eq)] = e.slice(eq + 1)
  }
  return out
}

function ulimitToCompose(spec: string): Record<string, unknown> | null {
  const eq = spec.indexOf('=')
  if (eq === -1) return null
  const name = spec.slice(0, eq)
  const vals = spec.slice(eq + 1).split(':')
  if (vals.length >= 2) {
    const soft = Number(vals[0])
    const hard = Number(vals[1])
    if (!Number.isNaN(soft) && !Number.isNaN(hard)) return { [name]: { soft, hard } }
  }
  const n = Number(vals[0])
  if (!Number.isNaN(n)) return { [name]: n }
  return null
}

function serviceKey(runcfg: RunConfig, index: number): string {
  const candidate = runcfg.name
    ? runcfg.name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[._-]+/, '')
    : runcfg.image
      ? runcfg.image.split('/')[runcfg.image.split('/').length - 1].split(/[:@]/)[0]
      : `service-${index + 1}`
  return candidate || `service-${index + 1}`
}

export function convertRun(cfg: RunConfig, _opts?: { index: number }): Service {
  const svc: Service = {}

  if (cfg.image) {
    svc.image = cfg.image
  }
  if (cfg.name) svc.container_name = cfg.name
  if (cfg.hostname) svc.hostname = cfg.hostname
  if (cfg.user) svc.user = cfg.user
  if (cfg.workdir) svc.working_dir = cfg.workdir
  if (cfg.entrypoint) svc.entrypoint = cfg.entrypoint
  if (cfg.args.length > 0) svc.command = [...cfg.args]

  if (cfg.pullPolicy) svc.pull_policy = cfg.pullPolicy

  // ports
  if (cfg.publishAll) {
    // publish-all is not expressible in compose; surface it as a warning upstream.
  }
  if (cfg.ports.length > 0) svc.ports = cfg.ports
  if (cfg.expose.length > 0) svc.expose = cfg.expose

  // volumes: short -v syntax + --mount
  const volumes: ComposeVolume[] = []
  for (const v of cfg.volumes) {
    const parsed = parseShortVolume(v)
    if (parsed) volumes.push(parsed)
  }
  for (const m of cfg.mounts) {
    const parsed = mountToCompose(m)
    if (parsed) volumes.push({ src: parsed.src, dst: parsed.dst, bind: parsed.bind, mode: parsed.ro ? 'ro' : undefined })
  }
  if (volumes.length > 0) {
    svc.volumes = volumes.map((v) => {
      // anonymous volume (no source) is just the container path
      if (!v.src) return v.dst
      const out = `${v.src}:${v.dst}`
      return v.mode ? `${out}:${v.mode}` : out
    })
  }

  const env = envToRecord(cfg.env)
  if (env) svc.environment = env
  if (cfg.envFiles.length > 0) svc.env_file = cfg.envFiles

  // networks
  const namedNetworks = cfg.networks.filter((n) => n !== 'host' && n !== 'none' && n !== '' && n !== 'default' && n !== 'bridge')
  const special = cfg.networks.find((n) => n === 'host' || n === 'none' || n === 'bridge')
  if (special) {
    svc.network_mode = special
  }
  if (namedNetworks.length > 0) {
    const netObj: Record<string, unknown> = {}
    for (const n of namedNetworks) netObj[n] = {}
    if (cfg.networkAliases.length > 0) {
      const first = namedNetworks[0]
      ;(netObj[first] as Record<string, unknown>).aliases = [...cfg.networkAliases]
    }
    if (cfg.ip) {
      const first = namedNetworks[0]
      ;(netObj[first] as Record<string, unknown>).ipv4_address = cfg.ip
    }
    svc.networks = netObj
  } else if (cfg.networkAliases.length > 0 && !special) {
    svc.networks = { default: { aliases: [...cfg.networkAliases] } }
  } else if (cfg.ip && !special) {
    svc.networks = { default: { ipv4_address: cfg.ip } }
  }

  if (cfg.restart) svc.restart = restartToCompose(cfg.restart)
  if (cfg.tty) svc.tty = true
  if (cfg.interactive) svc.stdin_open = true
  if (cfg.privileged) svc.privileged = true
  if (cfg.devices.length > 0) svc.devices = [...cfg.devices]
  if (cfg.capAdd.length > 0) svc.cap_add = cfg.capAdd
  if (cfg.capDrop.length > 0) svc.cap_drop = cfg.capDrop
  if (cfg.securityOpts.length > 0) svc.security_opt = cfg.securityOpts
  if (cfg.groupAdd.length > 0) svc.group_add = cfg.groupAdd
  if (cfg.readOnly) svc.read_only = true

  // healthcheck
  if (cfg.noHealthcheck) {
    svc.healthcheck = { disable: true }
  } else if (cfg.healthCmd) {
    const hc: Record<string, unknown> = {}
    const test = shellSplit(cfg.healthCmd)
    hc.test = test
    if (cfg.healthInterval) hc.interval = cfg.healthInterval
    if (cfg.healthTimeout) hc.timeout = cfg.healthTimeout
    if (cfg.healthRetries !== null) hc.retries = cfg.healthRetries
    if (cfg.healthStartPeriod) hc.start_period = cfg.healthStartPeriod
    svc.healthcheck = hc
  }

  // logging
  if (cfg.logDriver || cfg.logOpts.length > 0) {
    const logging: Record<string, unknown> = {}
    if (cfg.logDriver) logging.driver = cfg.logDriver
    if (cfg.logOpts.length > 0) {
      const options: Record<string, string> = {}
      for (const o of cfg.logOpts) {
        const eq = o.indexOf('=')
        if (eq !== -1) options[o.slice(0, eq)] = o.slice(eq + 1)
      }
      logging.options = options
    }
    svc.logging = logging
  }

  // ulimits
  if (cfg.ulimits.length > 0) {
    const ulimits: Record<string, unknown> = {}
    for (const u of cfg.ulimits) {
      const parsed = ulimitToCompose(u)
      if (parsed) Object.assign(ulimits, parsed)
    }
    if (Object.keys(ulimits).length > 0) svc.ulimits = ulimits
  }

  if (cfg.dns.length > 0) svc.dns = cfg.dns.length === 1 ? cfg.dns[0] : cfg.dns
  if (cfg.dnsSearch.length > 0) svc.dns_search = cfg.dnsSearch.length === 1 ? cfg.dnsSearch[0] : cfg.dnsSearch
  if (cfg.dnsOptions.length > 0) svc.dns_opt = cfg.dnsOptions
  if (cfg.addHosts.length > 0) svc.extra_hosts = cfg.addHosts.map((h) => h)

  if (cfg.labels.length > 0) {
    const labels: Record<string, string> = {}
    for (const l of cfg.labels) {
      const eq = l.indexOf('=')
      if (eq === -1) labels[l] = ''
      else labels[l.slice(0, eq)] = l.slice(eq + 1)
    }
    svc.labels = labels
  }

  if (cfg.init) svc.init = true
  if (cfg.tmpfs.length > 0) svc.tmpfs = cfg.tmpfs.length === 1 ? cfg.tmpfs[0] : cfg.tmpfs

  // resources
  if (cfg.memory) svc.mem_limit = cfg.memory
  if (cfg.memorySwap) svc.memswap_limit = cfg.memorySwap
  if (cfg.memoryReservation) svc.memory_reservation = cfg.memoryReservation
  if (cfg.cpus) svc.cpus = cfg.cpus
  if (cfg.cpuShares !== null) svc.cpu_shares = cfg.cpuShares
  if (cfg.cpuset) svc.cpuset = cfg.cpuset
  if (cfg.shmSize) svc.shm_size = cfg.shmSize

  if (cfg.stopSignal) svc.stop_signal = cfg.stopSignal
  if (cfg.stopTimeout) svc.stop_grace_period = cfg.stopTimeout
  if (cfg.pid) svc.pid = cfg.pid
  if (cfg.userns) svc.userns_mode = cfg.userns
  if (cfg.macAddress) svc.mac_address = cfg.macAddress
  if (cfg.runtime) svc.runtime = cfg.runtime
  if (cfg.isolation) svc.isolation = cfg.isolation

  if (cfg.sysctls.length > 0) {
    const sysctls: Record<string, string> = {}
    for (const s of cfg.sysctls) {
      const eq = s.indexOf('=')
      if (eq !== -1) sysctls[s.slice(0, eq)] = s.slice(eq + 1)
    }
    svc.sysctls = sysctls
  }

  return sortServiceKeys(svc)
}

function dedupe(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((raw) => {
    const n = seen.get(raw)
    seen.set(raw, (n ?? 0) + 1)
    return n ? `${raw}-${n + 1}` : raw
  })
}

export function convertAll(input: string): ConversionResult {
  const commands = splitCommands(input)
  const errors: string[] = []
  const warnings: string[] = []
  if (commands.length === 0) {
    errors.push('No commands found. Paste a docker run command, e.g.:\n  docker run -d --name web -p 8080:80 nginx:alpine')
    return { services: {}, yaml: '', warnings, errors, networks: {} }
  }

  const parsed = commands.map((c) => parseRun(c))
  for (const p of parsed) {
    warnings.push(...p.warnings)
  }
  // only keep commands that resolved to an image
  const runnable = parsed.filter((p) => p.image !== null)

  const names = dedupe(runnable.map((p) => serviceKey(p, 0)))
  const services: Record<string, Service> = {}
  runnable.forEach((p, idx) => {
    const svc = convertRun(p, { index: idx })
    const ignored = p.ignored
    if (ignored.length > 0) {
      // attach as YAML comments via keys we drop at emit time? simpler: collect warnings
      warnings.push(...ignored)
    }
    services[names[idx]] = svc
  })

  // Compose requires every service network to be declared top-level; these stay
  // auto-created by the file itself (not external).
  const networks: Record<string, unknown> = {}
  for (const svc of Object.values(services)) {
    if (svc.networks && typeof svc.networks === 'object' && !Array.isArray(svc.networks)) {
      for (const k of Object.keys(svc.networks as Record<string, unknown>)) {
        networks[k] = {}
      }
    }
  }

  const yaml = toYaml({ services, networks: Object.keys(networks).length > 0 ? networks : undefined })
  return { services, yaml, warnings, errors, networks }
}
