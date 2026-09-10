# Deploying bxhealth-fhir-mcp

Target: Ping SE DevOps cluster `ping-dev-aws-us-east-2`, namespace
`ping-devops-robpieper`. The service has **no Ingress** — it is reachable
only in-cluster at `http://bxhealth-fhir-mcp`, and from Phase 4 only
PingGateway calls it.

## Cluster facts worth knowing

- **All nodes are arm64** (Graviton `r7g.xlarge`), verified 2026-09-10.
  CI builds `linux/arm64` for that reason. An amd64 image fails as
  `exec format error` in CrashLoopBackOff, which reads like an app bug.
  Note this contradicts `bxhealth-demo-base/docs/setup-cluster.md`,
  which says the build needs an amd64 host; that doc is wrong.
- Default StorageClass is `gp2`. This service is stateless and claims no
  volume.
- The human kubeconfig authenticates through an **interactive OIDC exec
  plugin**, so it cannot be handed to CI (see below).

## One-time setup

### 1. CI deploy identity

`KUBE_CONFIG_B64` cannot be your own kubeconfig: the exec plugin needs a
browser. CI gets a namespace-scoped ServiceAccount instead.

```bash
kubectl apply -n ping-devops-robpieper -f infra/k8s/ci-rbac.yaml
```

Then build the kubeconfig from the issued token:

```bash
NS=ping-devops-robpieper
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CA=$(kubectl get secret github-deployer-token -n $NS -o jsonpath='{.data.ca\.crt}')
TOKEN=$(kubectl get secret github-deployer-token -n $NS -o jsonpath='{.data.token}' | base64 -d)

cat > ci-kubeconfig.yaml <<CFG
apiVersion: v1
kind: Config
clusters:
- name: ping-dev-aws-us-east-2
  cluster: { server: ${SERVER}, certificate-authority-data: ${CA} }
contexts:
- name: ci
  context: { cluster: ping-dev-aws-us-east-2, namespace: ${NS}, user: github-deployer }
current-context: ci
users:
- name: github-deployer
  user: { token: ${TOKEN} }
CFG

base64 < ci-kubeconfig.yaml | tr -d '\n' | gh secret set KUBE_CONFIG_B64
gh secret set K8S_NAMESPACE --body "$NS"
rm ci-kubeconfig.yaml
```

Verify it before trusting CI with it:

```bash
KUBECONFIG=ci-kubeconfig.yaml kubectl auth whoami
KUBECONFIG=ci-kubeconfig.yaml kubectl auth can-i patch deployments.apps -n $NS   # yes
KUBECONFIG=ci-kubeconfig.yaml kubectl auth can-i get secrets -n $NS              # no
```

### 2. Application secret

```bash
kubectl create secret generic bxhealth-fhir-mcp-secrets -n ping-devops-robpieper \
  --from-env-file=.env
```

Carries `PINGONE_ENV_ID`, `PINGONE_CLIENT_ID`, `PINGONE_CLIENT_SECRET`,
`FHIR_BASE_URL`. The FHIR base URL is not secret but lives here so there
is one place to change it. The CI ServiceAccount deliberately cannot
read this secret.

### 3. Container image

CI pushes `ghcr.io/robpieperping/bxhealth-fhir-mcp` using the workflow's
own `GITHUB_TOKEN`; no registry secret is needed.

**The package must be public**, because the manifest carries no
`imagePullSecret`. GHCR packages inherit the repository's visibility on
first push, so a package from a private repo starts private and the
first deploy fails with `ImagePullBackOff` until it is flipped:

> Package settings → Danger Zone → Change visibility → Public

To keep it private instead, create a `docker-registry` secret from a PAT
with `read:packages` and add `imagePullSecrets` back to the pod spec.

## Deploy

Push to `main`; the workflow runs `check` → `build-and-push` → `deploy`.
Manually:

```bash
kubectl apply -n ping-devops-robpieper -f infra/k8s/k8s.yaml
kubectl rollout status -n ping-devops-robpieper deploy/bxhealth-fhir-mcp
```

## Verify

There is no public URL by design, so verification goes through a
port-forward:

```bash
kubectl port-forward -n ping-devops-robpieper deploy/bxhealth-fhir-mcp 3000:3000

curl -s localhost:3000/healthz
curl -s localhost:3000/readyz    # reports the FHIR server's advertised fhirVersion
npx @modelcontextprotocol/inspector    # point at http://localhost:3000/mcp
```

## Notes

- **One replica, on purpose.** MCP sessions are held in memory keyed by
  `Mcp-Session-Id`. A second pod answers follow-up requests for sessions
  it never saw, producing intermittent `Session not found` 404s. Scaling
  up needs sticky sessions or a shared session store first.
- Both probes use `/healthz`, which never touches FHIR. `/readyz` does
  call FHIR and is the better-looking readiness probe, but wiring it in
  would evict the pod from the Service whenever FHIR hiccups, turning a
  clear tool error into an opaque 503.
- Teardown: `kubectl delete -f infra/k8s/k8s.yaml`. Per SE DevOps policy
  cleanup is your responsibility; `kubectl scale --replicas=0` is the
  cheap idle state.
