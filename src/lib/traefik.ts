import type { Service } from './convert'

/** Per-service Traefik routing settings, edited in the UI. */
export interface TraefikServiceSetting {
  enabled: boolean
  domain: string
  /** container port the router forwards to; empty = auto-guess from ports */
  port: string
}

/** Stack-level infra defaults shared by all of the user's compose stacks. */
export interface TraefikOptions {
  /** host network where the Traefik container lives */
  network: string
  /** if true, route the websecure entrypoint and stamp the cert resolver */
  tls: boolean
  resolver: string
  /** declare the host network as external (traefik runs in its own stack) */
  external: boolean
}

export type TraefikSettings = Record<string, TraefikServiceSetting>

/**
 * Heuristic: the [last field before an optional /proto] of the first -p entry
 * is the container port. `8080:80` → 80, `127.0.0.1:3000:3000` → 3000.
 */
export function guessContainerPort(svc: Service): string {
  const ports = svc.ports as string[] | undefined
  if (!Array.isArray(ports) || ports.length === 0) return ''
  const name = (ports[0] as string).split('/')[0]
  const segs = name.split(':')
  const last = segs[segs.length - 1]
  return /^\d+(-\d+)?$/.test(last) ? last : ''
}

function routerName(serviceName: string): string {
  return serviceName.toLowerCase().replace(/[^a-z0-9-_.]+/g, '-')
}

/**
 * Stamps Traefik labels on one service and attaches it to the host network.
 * Returns the top-level network(s) the doc must now declare.
 */
export function applyTraefikToService(
  serviceName: string,
  svc: Service,
  setting: TraefikServiceSetting,
  opts: TraefikOptions,
): Record<string, unknown> {
  const addNets: Record<string, unknown> = {}

  if (!setting.enabled) return addNets

  const router = routerName(serviceName)
  const labels: Record<string, string> = {}
  // preserve labels coming from --label
  const existing = svc.labels
  if (existing && typeof existing === 'object') {
    for (const [k, v] of Object.entries(existing as Record<string, unknown>)) {
      labels[k] = String(v)
    }
  }

  labels['traefik.enable'] = 'true'
  if (setting.domain) {
    labels[`traefik.http.routers.${router}.rule`] = `Host(\`${setting.domain}\`)`
    labels[`traefik.http.routers.${router}.entrypoints`] = opts.tls ? 'websecure' : 'web'
    if (opts.tls) {
      labels[`traefik.http.routers.${router}.tls`] = 'true'
      if (opts.resolver) {
        labels[`traefik.http.routers.${router}.tls.certresolver`] = opts.resolver
      }
    }
  }
  const port = setting.port || guessContainerPort(svc)
  if (port) {
    labels[`traefik.http.services.${router}.loadbalancer.server.port`] = port
  }

  svc.labels = labels

  // attach service to the traefik host network, preserving any other networks
  const nets: Record<string, unknown> = {}
  if (svc.networks && typeof svc.networks === 'object') {
    Object.assign(nets, svc.networks)
  } else if (svc.network_mode) {
    // network_mode and networks are mutually exclusive — leave as-is, warn caller in UI
    return addNets
  }
  nets[opts.network] = {}
  addNets[opts.network] = opts.external ? true : {}
  svc.networks = nets
  return addNets
}

/** Full document application: mutates a deep-cloned services record. */
export function applyTraefik(
  services: Record<string, Service>,
  settings: TraefikSettings,
  opts: TraefikOptions,
): { services: Record<string, Service>; networks: Record<string, unknown> } {
  const networks: Record<string, unknown> = {}

  // top-level declarations for named networks the services already reference
  for (const svc of Object.values(services)) {
    if (svc.networks && typeof svc.networks === 'object' && !Array.isArray(svc.networks)) {
      for (const [k, v] of Object.entries(svc.networks)) {
        if (!networks[k]) networks[k] = typeof v === 'object' && v !== null ? { ...v } : {}
      }
    }
  }

  for (const [name, svc] of Object.entries(services)) {
    const setting = settings[name] ?? { enabled: false, domain: '', port: '' }
    Object.assign(networks, applyTraefikToService(name, svc, setting, opts))
  }

  // `true` is the applyTraefikToService marker for “declare as external”;
  // the document itself wants an object.
  for (const k of Object.keys(networks)) {
    if (networks[k] === true) networks[k] = { external: true }
  }

  return { services, networks }
}

export function cloneServices(services: Record<string, Service>): Record<string, Service> {
  return JSON.parse(JSON.stringify(services))
}

/** Defaults for services seen for the first time. */
export function defaultServiceSettings(
  services: Record<string, Service>,
  existing: TraefikSettings,
): TraefikSettings {
  const out: TraefikSettings = { ...existing }
  const names = Object.keys(services)
  names.forEach((name, idx) => {
    if (!out[name]) {
      out[name] = {
        // the user fronts “all” their stacks with traefik: default the first
        // service on, databases/web workers almost never need it
        enabled: idx === 0,
        domain: '',
        port: guessContainerPort(services[name]) || '',
      }
    }
  })
  // drop settings for services that no longer exist
  for (const key of Object.keys(out)) {
    if (!services[key]) delete out[key]
  }
  return out
}
