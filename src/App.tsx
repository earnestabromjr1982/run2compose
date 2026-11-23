import { useMemo, useState, useEffect, useCallback } from 'react'
import YAMLLib from 'yaml'
import { convertAll } from './lib/convert'
import { toYaml } from './lib/yaml'
import {
  applyTraefik,
  cloneServices,
  defaultServiceSettings,
  type TraefikOptions,
  type TraefikSettings,
} from './lib/traefik'

const SAMPLES: Record<string, string> = {
  'Simple web server': `docker run -d --name web -p 8080:80 --restart unless-stopped nginx:alpine`,
  'Postgres + env': `docker run -d \\
  --name db \\
  -e POSTGRES_PASSWORD=secret \\
  -e POSTGRES_DB=app \\
  -v pgdata:/var/lib/postgresql/data \\
  --restart always \\
  postgres:17`,
  'The works': `docker run -d \\
  --name fullstack \\
  -p 127.0.0.1:3000:3000 \\
  -e NODE_ENV=production \\
  -e DEBUG=1 \\
  -v ./data:/app/data:ro \\
  -v cache:/app/.cache \\
  -v /etc/timezone:/etc/timezone:ro \\
  --restart on-failure:3 \\
  --network backend \\
  --net-alias fullstack.local \\
  --health-cmd "curl --fail http://localhost:3000/health || exit 1" \\
  --health-interval 30s \\
  --health-retries 3 \\
  --label com.example.owner=terrya \\
  --memory 512m \\
  --cpus 1.5 \\
  --cap-drop ALL \\
  --security-opt=no-new-privileges \\
  --security-opt seccomp=default \\
  --ulimit nofile=4096:8192 \\
  --log-driver json-file \\
  --log-opt max-size=10m \\
  --stop-signal SIGTERM \\
  node:22-slim \\
  node server.js`,
}

const DEFAULT_TRAEFIK: TraefikOptions = {
  network: 'traefik',
  tls: true,
  resolver: 'le',
  external: true,
}

function loadTraefikOptions(): TraefikOptions {
  try {
    const raw = localStorage.getItem('r2c.traefik.v2')
    if (raw) return { ...DEFAULT_TRAEFIK, ...JSON.parse(raw) }
  } catch {
    /* corrupt storage: fall back to defaults */
  }
  return DEFAULT_TRAEFIK
}

export default function App() {
  const [input, setInput] = useState(SAMPLES['Simple web server'])

  // Traefik infra defaults persist across visits (they're your standard setup)
  const [traefikOn, setTraefikOn] = useState(() => localStorage.getItem('r2c.traefik.on') === '1')
  const [traefikOpts, setTraefikOpts] = useState<TraefikOptions>(loadTraefikOptions)
  const [svcSettings, setSvcSettings] = useState<TraefikSettings>({})
  const [traefikOpen, setTraefikOpen] = useState(traefikOn)

  const converted = useMemo(() => convertAll(input), [input])

  useEffect(() => {
    setSvcSettings((prev) => defaultServiceSettings(converted.services, prev))
  }, [converted.services])

  useEffect(() => {
    localStorage.setItem('r2c.traefik.on', traefikOn ? '1' : '0')
  }, [traefikOn])

  useEffect(() => {
    localStorage.setItem('r2c.traefik.v2', JSON.stringify(traefikOpts))
  }, [traefikOpts])

  // Null = no manual edits; string = the user's chosen YAML.
  const [userText, setUserText] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const generatedYaml = useMemo(() => {
    if (!traefikOn) return converted.yaml
    const clone = cloneServices(converted.services)
    const { services, networks } = applyTraefik(clone, svcSettings, traefikOpts)
    return toYaml({ services, networks: Object.keys(networks).length > 0 ? networks : undefined })
  }, [traefikOn, converted.services, converted.yaml, svcSettings, traefikOpts])

  // Any regeneration invalidates manual edits (sources of truth changed).
  useEffect(() => {
    setUserText(null)
  }, [generatedYaml])

  const value = userText ?? generatedYaml
  const isEdited = userText !== null && userText !== generatedYaml

  const yamlError = useMemo(() => {
    if (!value.trim()) return null
    try {
      const doc = YAMLLib.parse(value)
      if (doc && typeof doc === 'object' && doc.services) return null
      return 'Document has no services key'
    } catch (err) {
      return `Invalid YAML: ${(err as Error).message.split('\n')[0]}`
    }
  }, [value])

  const setTraefikValue = <K extends keyof TraefikOptions>(key: K, v: TraefikOptions[K]) =>
    setTraefikOpts((o) => ({ ...o, [key]: v }))

  const updateService = (name: string, patch: Partial<TraefikSettings[string]>) =>
    setSvcSettings((s) => ({ ...s, [name]: { ...s[name], ...patch } }))

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const copy = useCallback(async () => {
    await navigator.clipboard.writeText(value)
    setCopied(true)
  }, [value])

  const download = useCallback(() => {
    const blob = new Blob([value], { type: 'text/yaml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'compose.yaml'
    a.click()
    URL.revokeObjectURL(url)
  }, [value])

  const serviceNames = Object.keys(converted.services)
  const lineCount = input.trim().length === 0 ? 0 : input.trim().split('\n').length

  return (
    <div className="app">
      <header className="header">
        <h1>
          <span className="logo">⇄</span> run2compose
        </h1>
        <p className="tagline">
          Paste <code>docker run</code> commands — get a <code>compose.yaml</code>, edit it right here before
          downloading.
        </p>
      </header>

      <div className="samples">
        {Object.keys(SAMPLES).map((name) => (
          <button key={name} className="chip" onClick={() => setInput(SAMPLES[name])}>
            {name}
          </button>
        ))}
        <button className="chip ghost" onClick={() => setInput('')}>Clear</button>
      </div>

      <section className={`traefik ${traefikOn ? 'on' : ''}`}>
        <div className="traefik-head">
          <label className="switch">
            <input type="checkbox" checked={traefikOn} onChange={(e) => {
              setTraefikOn(e.target.checked)
              setTraefikOpen(e.target.checked)
            }} />
            <span>Traefik reverse proxy</span>
          </label>
          <button className="iconbtn" onClick={() => setTraefikOpen((o) => !o)} title="Configure">
            {traefikOpen ? '▾' : '▸'} configure
          </button>
        </div>
        {traefikOpen && (
          <div className="traefik-body">
            <div className="traefik-row">
              <label>
                Host network
                <input value={traefikOpts.network} onChange={(e) => setTraefikValue('network', e.target.value)} />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={traefikOpts.tls}
                  onChange={(e) => setTraefikValue('tls', e.target.checked)}
                />
                TLS (websecure)
              </label>
              <label>
                Cert resolver
                <input
                  value={traefikOpts.resolver}
                  disabled={!traefikOpts.tls}
                  onChange={(e) => setTraefikValue('resolver', e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={traefikOpts.external}
                  onChange={(e) => setTraefikValue('external', e.target.checked)}
                />
                Network is external
              </label>
            </div>
            {traefikOn && serviceNames.length > 0 && (
              <table className="traefik-table">
                <thead>
                  <tr>
                    <th>Proxy</th>
                    <th>Service</th>
                    <th>Domain</th>
                    <th>Backend port</th>
                  </tr>
                </thead>
                <tbody>
                  {serviceNames.map((name) => {
                    const s = svcSettings[name]
                    if (!s) return null
                    return (
                      <tr key={name}>
                        <td>
                          <input
                            type="checkbox"
                            checked={s.enabled}
                            onChange={(e) => updateService(name, { enabled: e.target.checked })}
                          />
                        </td>
                        <td>{name}</td>
                        <td>
                          <input
                            type="text"
                            placeholder="app.example.com"
                            value={s.domain}
                            className={!s.enabled ? 'dim' : ''}
                            onChange={(e) => updateService(name, { domain: e.target.value })}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            placeholder="auto"
                            value={s.port}
                            className={!s.enabled ? 'dim' : ''}
                            onChange={(e) => updateService(name, { port: e.target.value })}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
            {traefikOn && <p className="hint">Services routed by Traefik must sit on the same Docker network as the Traefik container.</p>}
          </div>
        )}
      </section>

      <main className="panes">
        <section className="pane">
          <div className="pane-head">
            <span>Input — <code>docker run</code></span>
            <span className="muted">{lineCount} command{lineCount === 1 ? '' : 's'}</span>
          </div>
          <textarea
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={'docker run -d --name web -p 8080:80 nginx:alpine'}
          />
        </section>

        <section className="pane output">
          <div className="pane-head">
            <span>
              Output — <code>compose.yaml</code>
              {isEdited && <span className="badge">edited</span>}
              {yamlError ? <span className="badge bad">invalid</span> : traefikOn && <span className="badge good">traefik</span>}
            </span>
            <div className="actions">
              {isEdited && (
                <button className="subtle" onClick={() => setUserText(null)}>
                  Reset to generated
                </button>
              )}
              <button onClick={copy} disabled={!value}>{copied ? '✓ Copied' : 'Copy'}</button>
              <button onClick={download} disabled={!value}>Download</button>
            </div>
          </div>
          <textarea
            spellCheck={false}
            className="code"
            value={value}
            onChange={(e) => setUserText(e.target.value)}
            placeholder={'deploy:\n  services: {}\n'}
          />
        </section>
      </main>

      {(converted.errors.length > 0 || converted.warnings.length > 0 || yamlError) && (
        <footer className="notes">
          {converted.errors.map((e, i) => (
            <p key={`e${i}`} className="error">⚠ {e}</p>
          ))}
          {yamlError && <p className="error">⚠ {yamlError}</p>}
          {converted.warnings.map((w, i) => (
            <p key={`w${i}`} className="warning">· {w}</p>
          ))}
        </footer>
      )}
    </div>
  )
}
