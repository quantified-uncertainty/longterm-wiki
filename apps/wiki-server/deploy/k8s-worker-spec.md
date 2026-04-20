# Job Worker -- Kubernetes Deployment Spec

The job worker runs as a long-lived polling process in K8s, claiming jobs from the
wiki-server HTTP API and executing handlers (citation verification, page improvement,
etc.). It replaces the current GitHub Actions-based worker with a persistent, lower-latency
alternative.

## Container Configuration

- **Image**: `ghcr.io/quantified-uncertainty/longterm-wiki-worker:sha-<commit>`
- **Command**:
  ```
  node --import tsx/esm crux/worker/run.ts \
    --poll --poll-interval=5000 \
    --concurrency=5 \
    --types=claim-verification,citation-verify,resource-ingest,ping \
    --verbose
  ```
- **Replicas**: 3 (scaled from 1 for resource-ingest backlog clearance)
- **Resources**:
  - Requests: 256Mi memory, 250m CPU
  - Limits: 1Gi memory, 1000m CPU
- **terminationGracePeriodSeconds**: 600 (10 min -- allows in-flight jobs to finish)

## Health Probes

- **Liveness**: HTTP GET `/healthz` on port 3101, initialDelaySeconds 10, periodSeconds 30
- **Readiness**: HTTP GET `/healthz` on port 3101, initialDelaySeconds 5, periodSeconds 10

The worker exposes a minimal health HTTP server on `WORKER_HEALTH_PORT` (default 3101).
The `/healthz` endpoint returns 200 when the poll loop is active.

## Environment Variables (from K8s Secrets)

| Variable | Source | Description |
|----------|--------|-------------|
| `LONGTERMWIKI_SERVER_URL` | K8s Secret | Wiki-server base URL |
| `LONGTERMWIKI_SERVER_API_KEY` | K8s Secret | API key for job claim/complete endpoints |
| `ANTHROPIC_BILLING_KEY` | K8s Secret | For LLM-powered job handlers (see QUA-612 for naming rationale) |
| `WORKER_HEALTH_PORT` | ConfigMap or default | Health endpoint port (default: 3101) |

## Deployment YAML Template

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: longterm-wiki-worker
  labels:
    app: longterm-wiki-worker
spec:
  replicas: 3
  selector:
    matchLabels:
      app: longterm-wiki-worker
  template:
    metadata:
      labels:
        app: longterm-wiki-worker
    spec:
      terminationGracePeriodSeconds: 600
      containers:
        - name: worker
          image: ghcr.io/quantified-uncertainty/longterm-wiki-worker:sha-latest
          command:
            - node
            - --import
            - tsx/esm
            - crux/worker/run.ts
            - --poll
            - --poll-interval=5000
            - --concurrency=5
            - --types=claim-verification,citation-verify,resource-ingest,ping
            - --verbose
          ports:
            - name: health
              containerPort: 3101
              protocol: TCP
          env:
            - name: LONGTERMWIKI_SERVER_URL
              valueFrom:
                secretKeyRef:
                  name: longterm-wiki-worker-secrets
                  key: LONGTERMWIKI_SERVER_URL
            - name: LONGTERMWIKI_SERVER_API_KEY
              valueFrom:
                secretKeyRef:
                  name: longterm-wiki-worker-secrets
                  key: LONGTERMWIKI_SERVER_API_KEY
            - name: ANTHROPIC_BILLING_KEY
              valueFrom:
                secretKeyRef:
                  name: longterm-wiki-worker-secrets
                  key: ANTHROPIC_BILLING_KEY
            - name: WORKER_HEALTH_PORT
              value: "3101"
            - name: NODE_ENV
              value: production
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "1000m"
          livenessProbe:
            httpGet:
              path: /healthz
              port: health
            initialDelaySeconds: 10
            periodSeconds: 30
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            httpGet:
              path: /healthz
              port: health
            initialDelaySeconds: 5
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 3
```

## ArgoCD Configuration

The worker is managed as a separate ArgoCD Application in the
[quantified-uncertainty/ops](https://github.com/quantified-uncertainty/ops) repo.

1. Create a new ArgoCD Application manifest:
   ```yaml
   apiVersion: argoproj.io/v1alpha1
   kind: Application
   metadata:
     name: longterm-wiki-worker
     namespace: argocd
   spec:
     project: default
     source:
       repoURL: https://github.com/quantified-uncertainty/ops
       path: charts/longterm-wiki-worker
       targetRevision: HEAD
       helm:
         values: |
           image:
             repository: ghcr.io/quantified-uncertainty/longterm-wiki-worker
             tag: latest
     destination:
       server: https://kubernetes.default.svc
       namespace: longterm-wiki
     syncPolicy:
       automated:
         prune: true
         selfHeal: true
   ```

2. The GHA workflow (`worker-docker.yml`) updates the image tag via
   `argocd app set longterm-wiki-worker --helm-set image.tag=sha-<commit>`.

## Rollout Strategy

1. **Week 1-4 (Canary)**: Deploy the K8s worker alongside the GHA worker.
   Both claim jobs -- the atomic claim endpoint prevents double-processing.
   The K8s worker handles `claim-verification`, `citation-verify`, and `ping`
   while GHA continues handling all types.

2. **Week 4+**: After confirming stability via the Active Agents dashboard
   (`/internal/active-agents`), add `--exclude-types` to the GHA workflow
   for the types the K8s worker handles.

3. **Rollback**: Scale the K8s worker to 0 replicas:
   ```bash
   kubectl scale deployment longterm-wiki-worker --replicas=0 -n longterm-wiki
   ```
   The GHA scheduled workflow (every 30 min) automatically picks up unclaimed jobs.

## Secret Provisioning

The following secrets must be created in the `longterm-wiki` namespace before
the first deploy:

```bash
kubectl create secret generic longterm-wiki-worker-secrets \
  --namespace=longterm-wiki \
  --from-literal=LONGTERMWIKI_SERVER_URL=https://wiki-server.k8s.quantifieduncertainty.org \
  --from-literal=LONGTERMWIKI_SERVER_API_KEY=<api-key> \
  --from-literal=ANTHROPIC_BILLING_KEY=<anthropic-key>
```

These are the same values used by the wiki-server deployment. The API key
authenticates the worker's job claim/complete/fail requests.

## Networking

The worker makes **outbound HTTP only** -- it connects to:
- Wiki-server API (job queue operations)
- Anthropic API (LLM calls for verification handlers)

No Ingress or Service is needed. The health port (3101) is only used by K8s
probes within the cluster.

## Monitoring

- **Active Agents dashboard**: `/internal/active-agents` shows all registered workers
- **Job queue**: Wiki-server `/api/jobs` endpoint shows pending/running/completed jobs
- **Logs**: `kubectl logs -f deployment/longterm-wiki-worker -n longterm-wiki`
- **Alerts**: Configure based on pod restart count and liveness probe failures
