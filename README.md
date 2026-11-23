# run2compose

Converts `docker run` commands into Docker Compose YAML, in the browser. Paste one or many commands, get a single `compose.yaml`.

## Stack

- Vite + React + TypeScript (no runtime deps beyond react)
- Hand-written converter under `src/lib/`:
  - `tokenize.ts` — shell-like tokenizer (quotes, escapes, line continuations)
  - `splitCommands.ts` — splits multiline input / `&&` chains into individual commands
  - `parseRun.ts` — maps every `docker run` flag into a structured `RunConfig`
  - `convert.ts` — `RunConfig` → services document (bind vs named volumes, networks, healthchecks, ulimits, …)
  - `yaml.ts` — minimal YAML emitter with correct quoting rules

## Commands

```sh
npm run dev      # dev server
npm test         # vitest unit tests
npm run build    # production build
```

## CI/CD

`.gitlab-ci.yml` (works on gitlab.com or a self-hosted GitLab with the Container
Registry enabled):

- `test` — every push: `tsc -b` + vitest, npm cache keyed on the lockfile
- `build-push` — default branch only: docker build (the project's own
  Dockerfile) and push `$CI_REGISTRY_IMAGE:latest` + `$CI_REGISTRY_IMAGE:<sha>`
  to the GitLab registry; requires a runner with docker:dind support

To run the deployed container from the registry build instead of the local one,
swap `build: .` for `image: $CI_REGISTRY_IMAGE:latest` in `compose.yaml`.

## Deployment (home lab)

Multi-stage Dockerfile: `node:22-alpine` builds the vite bundle,
`nginx:1.27-alpine` serves it (SPA fallback, hashed-asset caching, healthcheck).

```sh
docker compose build
docker compose up -d
```

`compose.yaml` joins the shared external `traefik` network and follows the
house style: router `run2compose.deathstar.pve.teeaye.us`, entrypoint
`websecure`, cert resolver `le`. Point a CNAME for that name at the Traefik
host and it routes.
