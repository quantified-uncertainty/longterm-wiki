# Wiki Server — Kubernetes Deployment

The wiki-server runs as a Kubernetes Deployment managed by ArgoCD in the
[quantified-uncertainty/ops](https://github.com/quantified-uncertainty/ops) repo.

## How updates work

Every push to `production` that touches `apps/wiki-server/` or `pnpm-lock.yaml`
triggers the GitHub Actions workflow `.github/workflows/wiki-server-docker.yml`,
which:

1. Builds a Docker image
2. Pushes it to `ghcr.io/quantified-uncertainty/longterm-wiki-server:sha-<commit>`
3. Runs a pre-deploy smoke test against an ephemeral PostgreSQL
4. Updates the ArgoCD app (`longterm-wiki-server`) via CLI to the new tag
5. Waits for the rollout to go healthy
6. Runs a post-deploy smoke test against the live deployment

## TLS / Ingress Configuration

The wiki-server Hono app speaks **plain HTTP only** (no TLS termination in the app).
TLS must be terminated at the K8s ingress level.

### Required ingress configuration

The nginx ingress for `wiki-server.k8s.quantifieduncertainty.org` **must not** use
`ssl-passthrough`. SSL passthrough forwards raw TCP to the backend pod, but the
wiki-server only speaks HTTP, so TLS handshakes fail.

Instead, configure the ingress to terminate TLS using a cert-manager certificate:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: longterm-wiki-server
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    # Do NOT set nginx.ingress.kubernetes.io/ssl-passthrough: "true"
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - wiki-server.k8s.quantifieduncertainty.org
      secretName: wiki-server-tls
  rules:
    - host: wiki-server.k8s.quantifieduncertainty.org
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: longterm-wiki-server
                port:
                  number: 3000
```

### Prerequisites

- **cert-manager** must be installed in the cluster with a `ClusterIssuer` named
  `letsencrypt-prod` (or adjust the annotation to match your issuer name)
- The wildcard `*.k8s.quantifieduncertainty.org` DNS must resolve to the ingress
  controller's external IP
- The ingress controller must NOT have a global `--enable-ssl-passthrough` flag that
  applies to all hosts — if it does, either remove it or use a per-ingress annotation
  to disable passthrough for this specific host

### Verifying the fix

After applying the ingress change:

```bash
# Should complete successfully (valid TLS handshake)
curl -v https://wiki-server.k8s.quantifieduncertainty.org/health

# Should show a valid Let's Encrypt certificate
openssl s_client -connect wiki-server.k8s.quantifieduncertainty.org:443 -servername wiki-server.k8s.quantifieduncertainty.org </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer
```

### History

- **PR #2834**: Added a client-side `WIKI_SERVER_TLS_BYPASS` workaround that connected
  directly to the resolved IP with a dummy SNI to bypass the broken passthrough.
- **This PR**: Removes the TLS bypass workaround and documents the proper server-side fix.

## Required GitHub Actions secrets

| Secret | Description |
|--------|-------------|
| `ARGOCD_SERVER` | ArgoCD server hostname (no `https://`) |
| `ARGOCD_AUTH_TOKEN` | ArgoCD auth token with app-set permissions |
| `LONGTERMWIKI_SERVER_URL` | Wiki-server URL for post-deploy smoke tests |
| `LONGTERMWIKI_SERVER_API_KEY` | API key for smoke test requests |

`GITHUB_TOKEN` is provided automatically for GHCR push.
