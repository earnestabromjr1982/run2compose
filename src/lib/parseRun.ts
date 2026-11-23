import { tokenize } from './tokenize'

/**
 * Parses `docker run` flags into a structured config.
 *
 * Flags are only consumed until the first positional argument (the image);
 * everything after the image is the container command.
 */

export interface ComposeEntry {
  key: string
  value: unknown
}

export interface RunConfig {
  image: string | null
  /** argv after the image (the container command) */
  args: string[]
  entrypoint: string | null
  name: string | null
  hostname: string | null
  user: string | null
  workdir: string | null
  restart: string | null
  ports: string[]
  publishAll: boolean
  expose: string[]
  volumes: string[]
  mounts: string[]
  env: string[]
  envFiles: string[]
  labels: string[]
  networks: string[]
  networkAliases: string[]
  addHosts: string[]
  devices: string[]
  capAdd: string[]
  capDrop: string[]
  securityOpts: string[]
  groupAdd: string[]
  tmpfs: string[]
  ulimits: string[]
  dns: string[]
  dnsSearch: string[]
  dnsOptions: string[]
  logDriver: string | null
  logOpts: string[]
  healthCmd: string | null
  healthInterval: string | null
  healthTimeout: string | null
  healthRetries: number | null
  healthStartPeriod: string | null
  noHealthcheck: boolean
  privileged: boolean
  readOnly: boolean
  interactive: boolean
  tty: boolean
  init: boolean
  memory: string | null
  memorySwap: string | null
  memoryReservation: string | null
  cpus: string | null
  cpuShares: number | null
  cpuset: string | null
  shmSize: string | null
  stopSignal: string | null
  stopTimeout: string | null
  pid: string | null
  userns: string | null
  ip: string | null
  macAddress: string | null
  pullPolicy: string | null
  runtime: string | null
  isolation: string | null
  sysctls: string[]
  warnings: string[]
  /** informational flags that have no compose equivalent */
  ignored: string[]
}

function fresh(): RunConfig {
  return {
    image: null,
    args: [],
    entrypoint: null,
    name: null,
    hostname: null,
    user: null,
    workdir: null,
    restart: null,
    ports: [],
    publishAll: false,
    expose: [],
    volumes: [],
    mounts: [],
    env: [],
    envFiles: [],
    labels: [],
    networks: [],
    networkAliases: [],
    addHosts: [],
    devices: [],
    capAdd: [],
    capDrop: [],
    securityOpts: [],
    groupAdd: [],
    tmpfs: [],
    ulimits: [],
    dns: [],
    dnsSearch: [],
    dnsOptions: [],
    logDriver: null,
    logOpts: [],
    healthCmd: null,
    healthInterval: null,
    healthTimeout: null,
    healthRetries: null,
    healthStartPeriod: null,
    noHealthcheck: false,
    privileged: false,
    readOnly: false,
    interactive: false,
    tty: false,
    init: false,
    memory: null,
    memorySwap: null,
    memoryReservation: null,
    cpus: null,
    cpuShares: null,
    cpuset: null,
    shmSize: null,
    stopSignal: null,
    stopTimeout: null,
    pid: null,
    userns: null,
    ip: null,
    macAddress: null,
    pullPolicy: null,
    runtime: null,
    isolation: null,
    sysctls: [],
    warnings: [],
    ignored: [],
  }
}

/** short flags that carry a value; rest are boolean toggles (combinable) */
const SHORT_VALUE_FLAGS = new Set(['p', 'e', 'v', 'u', 'w', 'h', 'l', 'm'])

/** long flags that may be given with or without '=' */
const LONG_ALIASES: Record<string, string> = {
  detach: '',
  rm: '',
  interactive: '',
  tty: '',
  init: '',
  privileged: '',
  'read-only': '',
  publish: '',
  'publish-all': '',
  expose: '',
  volume: '',
  mount: '',
  env: '',
  'env-file': '',
  label: '',
  name: '',
  hostname: '',
  user: '',
  workdir: '',
  restart: '',
  network: '',
  net: '',
  'net-alias': '',
  'add-host': '',
  device: '',
  'cap-add': '',
  'cap-drop': '',
  'security-opt': '',
  'group-add': '',
  tmpfs: '',
  ulimit: '',
  dns: '',
  'dns-search': '',
  'dns-option': '',
  'log-driver': '',
  'log-opt': '',
  'health-cmd': '',
  'health-interval': '',
  'health-timeout': '',
  'health-retries': '',
  'health-start-period': '',
  'no-healthcheck': '',
  memory: '',
  'memory-swap': '',
  'memory-reservation': '',
  cpus: '',
  'cpu-shares': '',
  'cpuset-cpus': '',
  'cpuset-mems': '',
  'shm-size': '',
  'stop-signal': '',
  'stop-grace-period': '',
  timeout: '',
  pid: '',
  userns: '',
  ip: '',
  'mac-address': '',
  link: '',
  entrypoint: '',
  pull: '',
  runtime: '',
  isolation: '',
  sysctl: '',
  workdir2__unused: '',
}
void LONG_ALIASES

export function parseRun(command: string): RunConfig {
  const cfg = fresh()
  let tokens = tokenize(command)

  // Allow pasted prompts like `$ docker run …` (tokenizer also handles `$\ `)
  if (tokens[0] === 'docker' || tokens[0] === 'podman') tokens = tokens.slice(1)

  // `docker container run …` / `docker run …`. Bare fragments (`-e FOO=1 postgres`)
  // are tolerated; other subcommands are not ours.
  const SUBCOMMANDS = new Set([
    'ps', 'build', 'exec', 'images', 'pull', 'push', 'compose', 'inspect',
    'stop', 'start', 'restart', 'rm', 'rmi', 'logs', 'stats', 'top', 'kill',
    'create', 'container', 'image', 'volume', 'network', 'context', 'login',
    'logout', 'cp', 'diff', 'events', 'export', 'history', 'import', 'info',
    'load', 'pause', 'port', 'rename', 'save', 'search', 'system', 'tag',
    'unpause', 'update', 'version', 'wait',
  ])
  if (tokens[0] === 'container' && tokens[1] === 'run') {
    tokens = tokens.slice(2)
  } else if (tokens[0] === 'run') {
    tokens = tokens.slice(1)
  } else if (tokens.length > 0 && SUBCOMMANDS.has(tokens[0])) {
    cfg.warnings.push(`"${tokens[0]}" is not a docker run command — run2compose converts "docker run" commands`)
    return cfg
  }

  if (tokens.length === 0) return cfg

  let i = 0
  // Flags phase: only until first positional (the image).
  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok === '--') {
      // end of flags
      break
    }
    if (!tok.startsWith('-')) break

    let name = ''
    let value: string | null = null
    let hadInlineValue = false

    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=', 2)
      if (eq !== -1) {
        name = tok.slice(2, eq)
        value = tok.slice(eq + 1)
        hadInlineValue = true
      } else {
        name = tok.slice(2)
      }
      name = name.replace(/_+/g, '-') // docker accepts --cap_add etc.
      i++
      // unknown long flag: skip, warn
      if (!(name in longFlagSet) && name !== 'help') {
        cfg.warnings.push(`Unknown option --${name} (ignored)`)
      }
    } else {
      // short cluster, e.g. -it, -dp 8080:80, -e FOO=bar
      const chars = tok.slice(1)
      i++
      for (let c = 0; c < chars.length; c++) {
        const ch = chars[c]
        if (SHORT_VALUE_FLAGS.has(ch)) {
          // remainder of cluster is the value (if any), else next token
          const rest = chars.slice(c + 1)
          if (rest.length > 0) {
            value = rest.replace(/^=/, '')
            hadInlineValue = true
          }
          name = shortToLong[ch] ?? ''
          break
        } else {
          applyShortToggle(ch, cfg)
          name = ''
        }
      }
      if (name === undefined) name = ''
    }

    if ((name as string) === 'help' || name === '') continue

    const spec = longFlagSet[name]
    if (spec === undefined) continue

    if (spec === 'bool') {
      if (value === null) {
        applyBool(name, true, cfg)
        continue
      }
      // --name=value form on a boolean only happens for detach-keys style, treat value ignored
      applyBool(name, value !== 'false' && value !== '0', cfg)
      continue
    }

    // value-taking flag
    if (!hadInlineValue) {
      if (i >= tokens.length) {
        cfg.warnings.push(`Option --${name} is missing its value`)
        break
      }
      value = tokens[i]
      i++
    }
    if (name === 'help') continue
    applyValue(name, value as string, cfg)
  }

  // positional phase
  const rest = tokens.slice(i)
  // drop a stray '--' separator
  if (rest[0] === '--') rest.shift()
  cfg.image = rest[0] ?? null
  cfg.args = rest.slice(1)
  if (cfg.image === null) {
    cfg.warnings.push('No image found — is this a docker run command?')
  }
  return cfg
}

/** long flags that take an arbitrary value, repeated */
const longFlagSet: Record<string, 'bool' | 'value'> = {
  detach: 'bool',
  rm: 'bool',
  interactive: 'bool',
  tty: 'bool',
  init: 'bool',
  privileged: 'bool',
  'read-only': 'bool',
  'publish-all': 'bool',
  'no-healthcheck': 'bool',
  publish: 'value',
  expose: 'value',
  volume: 'value',
  mount: 'value',
  env: 'value',
  'env-file': 'value',
  label: 'value',
  name: 'value',
  hostname: 'value',
  user: 'value',
  workdir: 'value',
  restart: 'value',
  network: 'value',
  net: 'value',
  'net-alias': 'value',
  'add-host': 'value',
  device: 'value',
  'cap-add': 'value',
  'cap-drop': 'value',
  'security-opt': 'value',
  'group-add': 'value',
  tmpfs: 'value',
  ulimit: 'value',
  dns: 'value',
  'dns-search': 'value',
  'dns-option': 'value',
  'log-driver': 'value',
  'log-opt': 'value',
  'health-cmd': 'value',
  'health-interval': 'value',
  'health-timeout': 'value',
  'health-retries': 'value',
  'health-start-period': 'value',
  memory: 'value',
  'memory-swap': 'value',
  'memory-reservation': 'value',
  cpus: 'value',
  'cpu-shares': 'value',
  'cpuset-cpus': 'value',
  'cpuset-mems': 'value',
  'shm-size': 'value',
  'stop-signal': 'value',
  'stop-grace-period': 'value',
  timeout: 'value',
  pid: 'value',
  userns: 'value',
  ip: 'value',
  'mac-address': 'value',
  link: 'value',
  entrypoint: 'value',
  pull: 'value',
  runtime: 'value',
  isolation: 'value',
  sysctl: 'value',
}

const shortToLong: Record<string, string> = {
  d: 'detach',
  i: 'interactive',
  t: 'tty',
  p: 'publish',
  e: 'env',
  v: 'volume',
  u: 'user',
  w: 'workdir',
  h: 'hostname',
  l: 'label',
  m: 'memory',
}

function applyShortToggle(ch: string, cfg: RunConfig): void {
  switch (ch) {
    case 'd':
      cfg.ignored.push('-d/--detach (Compose services run detached by default)')
      break
    case 'i':
      cfg.interactive = true
      break
    case 't':
      cfg.tty = true
      break
    default:
      cfg.warnings.push(`Unknown short flag -${ch} (ignored)`)
  }
}

function applyBool(name: string, truthy: boolean, cfg: RunConfig): void {
  if (!truthy) return
  switch (name) {
    case 'interactive':
      cfg.interactive = true
      break
    case 'tty':
      cfg.tty = true
      break
    case 'init':
      cfg.init = true
      break
    case 'privileged':
      cfg.privileged = true
      break
    case 'read-only':
      cfg.readOnly = true
      break
    case 'publish-all':
      cfg.publishAll = true
      break
    case 'no-healthcheck':
      cfg.noHealthcheck = true
      break
    case 'detach':
      cfg.ignored.push('-d/--detach (Compose services run detached by default)')
      break
    case 'rm':
      cfg.ignored.push('--rm (not expressible in Compose)')
      break
  }
}

function applyValue(name: string, value: string, cfg: RunConfig): void {
  const pushSplit = (arr: string[], sep = ',') => {
    // for network lists: --network net1,net2
    arr.push(...value.split(sep).map((s) => s.trim()).filter(Boolean))
  }

  switch (name) {
    case 'publish': {
      cfg.ports.push(value)
      break
    }
    case 'expose': {
      cfg.expose.push(value)
      break
    }
    case 'volume': {
      cfg.volumes.push(value)
      break
    }
    case 'mount': {
      cfg.mounts.push(value)
      break
    }
    case 'env': {
      cfg.env.push(value)
      break
    }
    case 'env-file': {
      cfg.envFiles.push(value)
      break
    }
    case 'label': {
      cfg.labels.push(value)
      break
    }
    case 'name':
      cfg.name = value
      break
    case 'hostname':
      cfg.hostname = value
      break
    case 'user':
      cfg.user = value
      break
    case 'workdir':
      cfg.workdir = value
      break
    case 'restart':
      cfg.restart = value
      break
    case 'network':
    case 'net':
      pushSplit(cfg.networks)
      break
    case 'net-alias': {
      pushSplit(cfg.networkAliases, ',')
      break
    }
    case 'add-host':
      cfg.addHosts.push(value)
      break
    case 'device':
      cfg.devices.push(value)
      break
    case 'cap-add': {
      pushSplit(cfg.capAdd)
      break
    }
    case 'cap-drop': {
      pushSplit(cfg.capDrop)
      break
    }
    case 'security-opt': {
      pushSplit(cfg.securityOpts, ',')
      break
    }
    case 'group-add': {
      pushSplit(cfg.groupAdd)
      break
    }
    case 'tmpfs': {
      pushSplit(cfg.tmpfs)
      break
    }
    case 'ulimit':
      cfg.ulimits.push(value)
      break
    case 'dns':
      pushSplit(cfg.dns)
      break
    case 'dns-search':
      pushSplit(cfg.dnsSearch)
      break
    case 'dns-option':
      pushSplit(cfg.dnsOptions)
      break
    case 'log-driver':
      cfg.logDriver = value
      break
    case 'log-opt':
      cfg.logOpts.push(value)
      break
    case 'health-cmd':
      cfg.healthCmd = value.replace(/^["']|["']$/g, '')
      break
    case 'health-interval':
      cfg.healthInterval = value
      break
    case 'health-timeout':
      cfg.healthTimeout = value
      break
    case 'health-retries': {
      const n = parseInt(value, 10)
      if (!Number.isNaN(n)) cfg.healthRetries = n
      break
    }
    case 'health-start-period':
      cfg.healthStartPeriod = value
      break
    case 'memory':
      cfg.memory = value
      break
    case 'memory-swap':
      cfg.memorySwap = value
      break
    case 'memory-reservation':
      cfg.memoryReservation = value
      break
    case 'cpus':
      cfg.cpus = value
      break
    case 'cpu-shares': {
      const n = parseInt(value, 10)
      if (!Number.isNaN(n)) cfg.cpuShares = n
      break
    }
    case 'cpuset-cpus':
      cfg.cpuset = value
      break
    case 'shm-size':
      cfg.shmSize = value
      break
    case 'stop-signal':
      cfg.stopSignal = value
      break
    case 'stop-grace-period':
    case 'timeout':
      cfg.stopTimeout = value
      break
    case 'pid':
      cfg.pid = value
      break
    case 'userns':
      cfg.userns = value
      break
    case 'ip':
      cfg.ip = value
      break
    case 'mac-address':
      cfg.macAddress = value
      break
    case 'link':
      cfg.warnings.push(`Legacy --link is ignored by user-defined networks: ${value}`)
      break
    case 'entrypoint':
      cfg.entrypoint = value
      break
    case 'pull':
      cfg.pullPolicy = value === 'not_present' ? 'missing' : value
      break
    case 'runtime':
      cfg.runtime = value
      break
    case 'isolation':
      cfg.isolation = value
      break
    case 'sysctl':
      cfg.sysctls.push(value)
      break
    default:
      cfg.warnings.push(`Unsupported option --${name} (ignored)`)
  }
}
