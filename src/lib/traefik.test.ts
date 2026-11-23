import { describe, expect, it } from 'vitest'
import { guessContainerPort, applyTraefikToService, applyTraefik, defaultServiceSettings } from './traefik'
import { convertAll, type Service } from './convert'
import { toYaml } from './yaml'
import YAMLLib from 'yaml'

const OPTS = { network: 'proxy', tls: true, resolver: 'letsencrypt', external: true }

const labelsOf = (svc: Service): Record<string, string> => (svc.labels ?? {}) as Record<string, string>

describe('guessContainerPort', () => {
  const svc = (ports?: string[]) => ({ ports })
  it('reads the container side of the first -p entry', () => {
    expect(guessContainerPort(svc(['8080:80']))).toBe('80')
    expect(guessContainerPort(svc(['127.0.0.1:3000:3000']))).toBe('3000')
    expect(guessContainerPort(svc(['53:53/udp']))).toBe('53')
    expect(guessContainerPort(svc([]))).toBe('')
    expect(guessContainerPort(svc(undefined))).toBe('')
  })
})

describe('applyTraefikToService', () => {
  it('stamps enable + rule + entrypoint + resolver + LB port labels', () => {
    const svc = convertAll('docker run -p 8080:80 nginx').services.nginx
    const addNets = applyTraefikToService('nginx', svc, { enabled: true, domain: 'app.example.com', port: '' }, OPTS)
    expect(svc.labels).toEqual({
      'traefik.enable': 'true',
      'traefik.http.routers.nginx.rule': 'Host(`app.example.com`)',
      'traefik.http.routers.nginx.entrypoints': 'websecure',
      'traefik.http.routers.nginx.tls': 'true',
      'traefik.http.routers.nginx.tls.certresolver': 'letsencrypt',
      'traefik.http.services.nginx.loadbalancer.server.port': '80',
    })
    expect(svc.networks).toEqual({ proxy: {} })
    expect(addNets).toEqual({ proxy: true })
  })

  it('preserves pre-existing labels from --label', () => {
    const svc = convertAll('--label com.example.owner=me -p 80:80 nginx').services.nginx
    applyTraefikToService('nginx', svc, { enabled: true, domain: '', port: '8080' }, OPTS)
    expect(labelsOf(svc)['com.example.owner']).toBe('me')
    expect(labelsOf(svc)['traefik.http.services.nginx.loadbalancer.server.port']).toBe('8080')
  })

  it('no domain → no rule labels, still enabled with LB port', () => {
    const svc = convertAll('-p 80:80 nginx').services.nginx
    applyTraefikToService('nginx', svc, { enabled: true, domain: '', port: '' }, OPTS)
    expect(labelsOf(svc)['traefik.enable']).toBe('true')
    expect(Object.keys(labelsOf(svc)).filter((k) => k.includes('routers'))).toEqual([])
    expect(labelsOf(svc)['traefik.http.services.nginx.loadbalancer.server.port']).toBe('80')
  })

  it('disabled service is untouched and declares nothing', () => {
    const svc = convertAll('-p 80:80 nginx').services.nginx
    const add = applyTraefikToService('nginx', svc, { enabled: false, domain: '', port: '' }, OPTS)
    expect(add).toEqual({})
    expect(svc.labels).toBeUndefined()
  })

  it('http (no TLS) routes the web entrypoint', () => {
    const svc = convertAll('-p 80:80 nginx').services.nginx
    applyTraefikToService('nginx', svc, { enabled: true, domain: 'a.b', port: '' }, { ...OPTS, tls: false })
    expect(labelsOf(svc)['traefik.http.routers.nginx.entrypoints']).toBe('web')
    expect(labelsOf(svc)['traefik.http.routers.nginx.tls.certresolver']).toBeUndefined()
  })
})

describe('applyTraefik doc assembly', () => {
  it('returns top-level proxy network (external when configured) and keeps backend', () => {
    const { services } = convertAll('docker run --network backend --name web -p 80:80 nginx')
    const { services: out, networks: nets } = applyTraefik(
      JSON.parse(JSON.stringify(services)),
      { web: { enabled: true, domain: 'web.example.com', port: '' } },
      OPTS,
    )
    expect(out.web.networks).toEqual({ backend: {}, proxy: {} })
    expect(nets).toEqual({ backend: {}, proxy: { external: true } })
  })

  it('internal network (not external) when external=false', () => {
    const { services } = convertAll('docker run -p 80:80 nginx')
    const { networks: nets } = applyTraefik(
      JSON.parse(JSON.stringify(services)),
      { nginx: { enabled: true, domain: '', port: '' } },
      { ...OPTS, external: false },
    )
    expect(nets.proxy).toEqual({})
  })
})

describe('full pipeline renders valid YAML with traefik labels', () => {
  it('round-trips through the yaml package', () => {
    const conv = convertAll('docker run -d --name web -p 8080:80 nginx:alpine')
    const { services, networks } = applyTraefik(
      JSON.parse(JSON.stringify(conv.services)),
      { web: { enabled: true, domain: 'app.example.com', port: '' } },
      OPTS,
    )
    const yaml = toYaml({
      services,
      networks: Object.keys(networks).length > 0 ? networks : undefined,
    })
    expect(yaml).toContain("traefik.enable: 'true'")
    expect(yaml).toContain('Host(`app.example.com`)')
    const doc = YAMLLib.parse(yaml) as { services: Record<string, { labels: Record<string, string> }>; networks: { proxy: { external: boolean } } }
    expect(doc.services.web.labels['traefik.http.routers.web.rule']).toBe('Host(`app.example.com`)')
    expect(doc.networks.proxy.external).toBe(true)
  })
})

describe('defaultServiceSettings', () => {
  it('enables the first service by default, remembers edits, prunes stale entries', () => {
    const { services } = convertAll('docker run nginx\ndocker run postgres')
    const first = defaultServiceSettings(services, {})
    expect(first.nginx?.enabled).toBe(true)
    expect(first.postgres?.enabled).toBe(false)
    const remembered = defaultServiceSettings(services, { nginx: { enabled: false, domain: '', port: '' } })
    expect(remembered.nginx?.enabled).toBe(false)
    const pruned = defaultServiceSettings({ nginx: services.nginx }, remembered)
    expect(Object.keys(pruned)).toEqual(['nginx'])
  })
})
