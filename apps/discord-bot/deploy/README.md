# Discord Bot — Kubernetes Deployment

The bot runs as a Kubernetes Deployment managed by ArgoCD in the
[quantified-uncertainty/ops](https://github.com/quantified-uncertainty/ops) repo.

## How updates work

Every push to `main` that touches `apps/discord-bot/`, `content/`, or
`pnpm-lock.yaml` triggers the GitHub Actions workflow
`.github/workflows/discord-bot-docker.yml`, which:

1. Builds a Docker image with the bot source **and wiki content baked in**
2. Pushes it to `ghcr.io/quantified-uncertainty/longterm-wiki-discord-bot:sha-<commit>`
3. Updates the ArgoCD app (`longterm-wiki-discord-bot`) via CLI to the new tag
4. Waits for the rollout to go healthy

Because wiki content (`content/`) is baked into the image, every wiki page
update automatically produces a fresh deployment — no manual pull needed.

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
  DISCORD_TOKEN: ""         # injected from k8s secret
  ANTHROPIC_API_KEY: ""     # injected from k8s secret
  WIKI_BASE_URL: "https://www.longtermwiki.com"
  # WIKI_ROOT is not needed — defaults to /repo inside the image
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
  -n <namespace>
```
