# Discord Bot — Kubernetes Deployment

The bot runs as a Kubernetes Deployment managed by ArgoCD in the
[quantified-uncertainty/ops](https://github.com/quantified-uncertainty/ops) repo.

## How updates work

Every push to `main` that touches `apps/discord-bot/` or `pnpm-lock.yaml`
triggers the GitHub Actions workflow `.github/workflows/discord-bot-docker.yml`,
which:

1. Builds a Docker image with the bot source
2. Pushes it to `ghcr.io/quantified-uncertainty/longterm-wiki-discord-bot:sha-<commit>`
3. Updates the ArgoCD app (`longterm-wiki-discord-bot`) via CLI to the new tag
4. Waits for the rollout to go healthy

The bot reads wiki content from the wiki-server API at runtime (not baked into
the image), so wiki content updates do not trigger Docker rebuilds. The `/ask`
command also has a baked-in copy of `content/docs/` and `data/` for file-based
research via Claude Code — this snapshot updates on each image rebuild.

## Features

| Feature | Trigger | Auth | Description |
|---------|---------|------|-------------|
| Wiki Q&A | @mention | `ANTHROPIC_API_KEY` | Fast wiki search via API tools |
| Deep research | `/ask` command | `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code with file + API tools |

Both features are independently optional — the bot needs at least one auth key.

## First-time setup (ops repo)

Add an entry to `k8s/app-manifests/values.yaml` in the ops repo and create
`k8s/apps/longterm-wiki-discord-bot/` with a minimal Helm chart:

```
k8s/apps/longterm-wiki-discord-bot/
  Chart.yaml
  values.yaml          # see below
  templates/
    deployment.yaml
    secret.yaml        # or use external-secrets
```

### `values.yaml` (minimum)

```yaml
image:
  name: ghcr.io/quantified-uncertainty/longterm-wiki-discord-bot
  tag: main   # ArgoCD CI updates this to sha-<commit> on each push

env:
  DISCORD_TOKEN: ""                    # injected from k8s secret
  ANTHROPIC_API_KEY: ""                # injected from k8s secret (optional if using OAuth)
  CLAUDE_CODE_OAUTH_TOKEN: ""          # injected from k8s secret (enables /ask command)
  LONGTERMWIKI_SERVER_URL: ""          # injected from k8s secret
  LONGTERMWIKI_SERVER_API_KEY: ""      # injected from k8s secret
  WIKI_BASE_URL: "https://www.longtermwiki.com"
  # WIKI_REPO_PATH is set in Dockerfile to /wiki-content
```

### `templates/deployment.yaml` (sketch)

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: longterm-wiki-discord-bot
spec:
  replicas: 1
  selector:
    matchLabels:
      app: longterm-wiki-discord-bot
  template:
    metadata:
      labels:
        app: longterm-wiki-discord-bot
    spec:
      containers:
        - name: bot
          image: "{{ .Values.image.name }}:{{ .Values.image.tag }}"
          envFrom:
            - secretRef:
                name: longterm-wiki-discord-bot-secrets
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              memory: 512Mi
```

## Required GitHub Actions secrets

| Secret | Description |
|--------|-------------|
| `ARGOCD_SERVER` | ArgoCD server hostname (no `https://`) |
| `ARGOCD_AUTH_TOKEN` | ArgoCD auth token with app-set permissions |

`GITHUB_TOKEN` is provided automatically for GHCR push.

## Required Kubernetes secret

Create a secret `longterm-wiki-discord-bot-secrets` in the bot's namespace:

```bash
kubectl create secret generic longterm-wiki-discord-bot-secrets \
  --from-literal=DISCORD_TOKEN=<token> \
  --from-literal=ANTHROPIC_API_KEY=<key> \
  --from-literal=CLAUDE_CODE_OAUTH_TOKEN=<oauth-token> \
  --from-literal=LONGTERMWIKI_SERVER_URL=<wiki-server-url> \
  --from-literal=LONGTERMWIKI_SERVER_API_KEY=<api-key> \
  -n <namespace>
```

### Setting up the OAuth token

The `/ask` command requires a Claude Max subscription OAuth token:

1. SSH into the server with port forwarding: `ssh -L 8080:localhost:8080 server`
2. Run `claude setup-token` on the server (opens browser for authentication)
3. Copy the generated token (`sk-ant-oat01-...`)
4. Add it to the K8s secret as `CLAUDE_CODE_OAUTH_TOKEN`

The token lasts ~1 year. If queries start failing with auth errors, refresh it.
