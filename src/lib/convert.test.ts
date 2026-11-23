import { describe, expect, it } from 'vitest'
import { tokenize, splitCommands } from './tokenize'
import { parseRun } from './parseRun'
import { convertRun, convertAll, isBindSource } from './convert'

describe('tokenize', () => {
  it('splits on whitespace outside quotes', () => {
    expect(tokenize('docker run -d nginx')).toEqual(['docker', 'run', '-d', 'nginx'])
  })

  it('keeps quoted spaces intact', () => {
    expect(tokenize("--health-cmd 'curl -f || exit 1'")).toEqual(['--health-cmd', 'curl -f || exit 1'])
    expect(tokenize('-e GREETING="hello world"')).toEqual(['-e', 'GREETING=hello world'])
  })

  it('joins backslash-newline continuations', () => {
    expect(tokenize('-e A=1 \\\n  -e B=2')).toEqual(['-e', 'A=1', '-e', 'B=2'])
  })
})

describe('splitCommands', () => {
  it('splits multiline commands but respects continuations', () => {
    const input = 'docker run -d nginx \\\n  -e FOO=bar\ndocker run redis'
    expect(splitCommands(input)).toEqual(['docker run -d nginx   -e FOO=bar', 'docker run redis'])
  })

  it('splits on &&', () => {
    expect(splitCommands('docker run nginx && docker run redis')).toEqual([
      'docker run nginx',
      'docker run redis',
    ])
  })

  it('strips $ prompt', () => {
    expect(splitCommands('$ docker run nginx')).toEqual(['docker run nginx'])
  })
})

describe('parseRun', () => {
  it('extracts image and args', () => {
    const cfg = parseRun('docker run node:22-slim node server.js')
    expect(cfg.image).toBe('node:22-slim')
    expect(cfg.args).toEqual(['node', 'server.js'])
  })

  it('treats flags after the image as command args, not options', () => {
    const cfg = parseRun('docker run nginx -g "daemon off;"')
    expect(cfg.image).toBe('nginx')
    expect(cfg.args).toEqual(['-g', 'daemon off;'])
  })

  it('handles combined short toggles and valued shorts', () => {
    const cfg = parseRun('docker run -dit -m 512m redis')
    expect(cfg.image).toBe('redis')
    expect(cfg.interactive).toBe(true)
    expect(cfg.tty).toBe(true)
    expect(cfg.memory).toBe('512m')
  })

  it('parses inline = values on long flags', () => {
    const cfg = parseRun('docker run --restart=always --name web=-studio nginx')
    expect(cfg.restart).toBe('always')
    expect(cfg.name).toBe('web=-studio')
  })

  it('rejects non-run docker commands', () => {
    const cfg = parseRun('docker ps -a')
    expect(cfg.image).toBeNull()
    expect(cfg.warnings.join(' ')).toContain('"ps" is not a docker run command')
  })
})

describe('convertRun', () => {
  const base = { index: 0 }

  it('maps basic keys', () => {
    const cfg = parseRun('docker run -d --name web -w /var/www -u nobody -h web.internal nginx')
    const svc = convertRun(cfg, base)
    expect(svc).toEqual({
      image: 'nginx',
      container_name: 'web',
      working_dir: '/var/www',
      user: 'nobody',
      hostname: 'web.internal',
    })
  })

  it('maps ports and volumes with mode', () => {
    const cfg = parseRun('docker run -p 8080:80/tcp -p 9090/udp -v ./site:/usr/share/nginx/html:ro nginx')
    const svc = convertRun(cfg, base)
    expect(svc.ports).toEqual(['8080:80/tcp', '9090/udp'])
    expect(svc.volumes).toEqual(['./site:/usr/share/nginx/html:ro'])
  })

  it('maps environment with passthrough nulls', () => {
    const cfg = parseRun('-e POSTGRES_PASSWORD=secret -e PG_USER -e DEBUG=1 postgres')
    const svc = convertRun(cfg, base)
    expect(svc.environment).toEqual({ POSTGRES_PASSWORD: 'secret', PG_USER: null, DEBUG: '1' })
  })

  it('named volumes stay volumes, paths are binds (both short syntax)', () => {
    const cfg = parseRun('-v pgdata:/var/lib/postgresql/data -v /host:/host -v ./rel:/rel postgres')
    const svc = convertRun(cfg, base)
    expect(svc.volumes).toEqual(['pgdata:/var/lib/postgresql/data', '/host:/host', './rel:/rel'])
    expect(cfg.volumes[0]).toBe('pgdata:/var/lib/postgresql/data')
  })

  it('isBindSource discriminates named volumes from paths', () => {
    expect(isBindSource('pgdata')).toBe(false)
    expect(isBindSource('postgres-data')).toBe(false)
    expect(isBindSource('/var/lib')).toBe(true)
    expect(isBindSource('./one')).toBe(true)
    expect(isBindSource('~/one')).toBe(true)
    expect(isBindSource('C:/Users')).toBe(true)
  })

  it('healthcheck becomes a structured object', () => {
    const cfg = parseRun(
      '--health-cmd "curl --fail http://localhost:3000/health || exit 1" --health-interval 30s --health-retries 3 nginx',
    )
    const svc = convertRun(cfg, base)
    expect(svc.healthcheck).toEqual({
      test: ['curl', '--fail', 'http://localhost:3000/health', '||', 'exit', '1'],
      interval: '30s',
      retries: 3,
    })
  })

  it('restart policies with retry counts', () => {
    expect(convertRun(parseRun('--restart on-failure:5 nginx'), base).restart).toEqual({
      condition: 'on-failure',
      max_attempts: 5,
    })
    expect(convertRun(parseRun('--restart unless-stopped nginx'), base).restart).toBe('unless-stopped')
    expect(convertRun(parseRun('--restart no nginx'), base).restart).toBe('no')
  })

  it('network mode vs networks, alias attached to first network', () => {
    expect(convertRun(parseRun('--network host nginx'), base).network_mode).toBe('host')
    const svc = convertRun(parseRun('--network backend,monitor --net-alias fullstack.local nginx'), base)
    expect(svc.networks).toEqual({ backend: { aliases: ['fullstack.local'] }, monitor: {} })
  })

  it('logging, labels, ulimits, resources', () => {
    const cfg = parseRun(
      '--log-driver json-file --log-opt max-size=10m --label com.example.owner=me --ulimit nofile=4096:8192 --memory 512m --cpus 1.5 nginx',
    )
    const svc = convertRun(cfg, base)
    expect(svc.logging).toEqual({ driver: 'json-file', options: { 'max-size': '10m' } })
    expect(svc.labels).toEqual({ 'com.example.owner': 'me' })
    expect(svc.ulimits).toEqual({ nofile: { soft: 4096, hard: 8192 } })
    expect(svc.mem_limit).toBe('512m')
    expect(svc.cpus).toBe('1.5')
  })

  it('service key derives from image or --name', () => {
    expect(convertRun(parseRun('docker run nginx:alpine'), base).image).toBe('nginx:alpine')
  })
})

describe('convertAll', () => {
  it('renders multiple commands into one compose file, in key order', () => {
    const { yaml, warnings, errors } = convertAll(
      [
        'docker run -d --name db -e POSTGRES_PASSWORD=pw -v pgdata:/data --restart always postgres:17',
        'docker run --name web -p 8080:80 --network backend -t -i nginx',
      ].join('\n'),
    )
    expect(errors).toEqual([])
    expect(warnings).toEqual(['-d/--detach (Compose services run detached by default)'])
    expect(yaml).toBe(
      [
        'services:',
        '  db:',
        '    image: postgres:17',
        '    container_name: db',
        '    volumes:',
        "      - pgdata:/data",
        '    environment:',
        '      POSTGRES_PASSWORD: pw',
        '    restart: always',
        '  web:',
        '    image: nginx',
        '    container_name: web',
        '    ports:',
        '      - 8080:80',
        '    networks:',
        '      backend: {}',
        '    tty: true',
        '    stdin_open: true',
        'networks:',
        '  backend: {}',
        '',
      ].join('\n'),
    )
  })

  it('dedupes service names', () => {
    const dedupeProcessed = convertAll('docker run --name web nginx\ndocker run --name web redis')
    expect(Object.keys(dedupeProcessed.services).sort().join(',')) // service names get suffixes
      .toContain('web-2')
  })

  it('emits quoted scalars that would otherwise parse as numbers', () => {
    const { yaml } = convertAll('docker run -e PORT=0042 nginx')
    expect(yaml).toContain("'0042'")
  })
})