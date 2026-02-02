# ConceptualAI: Sandboxing & Containerization Plan

> **Team:** Davis & Anthony  
> **Goal:** Isolate per-user AI pipeline execution via ephemeral Docker containers, solving both filesystem contention during test-run loops and per-user Gemini API key management — without changing existing pipeline concepts.

## Problem Statement

ConceptualAI's Implementing concept writes generated code and tests to temporary directories, then runs `deno test` on them. If two users are generating simultaneously, their files can collide. Additionally, users provide their own Gemini API keys, which must never be persisted to our database but need to be available to all DSPy processes within a session.

Containerization solves both:
1. **Filesystem isolation** — each user's test-run loop operates in its own container filesystem
2. **API key isolation** — each user's key lives only in their container's environment, and is destroyed with the container

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Frontend (Vue)                                 │
│   - App description input, clarification Q&A, progress, download        │
│   - API key input (held in memory, sent per-session, never stored)      │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ HTTPS
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Central Gateway (persistent)                         │
│                                                                          │
│  Concepts:                                                               │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐  │
│  │ Authenticat- │ │ Sessioning   │ │ Profiling     │ │ Sandboxing   │  │
│  │ ing          │ │              │ │               │ │ (NEW)        │  │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘  │
│  ┌──────────────┐                                                       │
│  │ ProjectLedg- │  ← also accessible from sandbox containers via        │
│  │ er           │    shared MongoDB                                      │
│  └──────────────┘                                                       │
│                                                                          │
│  Requesting:                                                             │
│  - Auth routes (register, login) → handled locally                       │
│  - Project list/status routes → query MongoDB directly                   │
│  - Pipeline routes → proxied to user's sandbox endpoint                  │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │ proxy pipeline requests
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │ Sandbox A│ │ Sandbox B│ │ Sandbox C│
        │ (User A) │ │ (User B) │ │ (User C) │
        │          │ │          │ │          │
        │ Planning │ │ Planning │ │ Planning │
        │ Concept- │ │ Concept- │ │ Concept- │
        │ Designing│ │ Designing│ │ Designing│
        │ Implemen-│ │ Implemen-│ │ Implemen-│
        │ ting     │ │ ting     │ │ ting     │
        │ SyncGen  │ │ SyncGen  │ │ SyncGen  │
        │ Assemb-  │ │ Assemb-  │ │ Assemb-  │
        │ ling     │ │ ling     │ │ ling     │
        │ Frontend-│ │ Frontend-│ │ Frontend-│
        │ Generat- │ │ Generat- │ │ Generat- │
        │ ing      │ │ ing      │ │ ing      │
        │          │ │          │ │          │
        │ env:     │ │ env:     │ │ env:     │
        │ GEMINI_  │ │ GEMINI_  │ │ GEMINI_  │
        │ API_KEY  │ │ API_KEY  │ │ API_KEY  │
        │ MONGO_   │ │ MONGO_   │ │ MONGO_   │
        │ URI      │ │ URI      │ │ URI      │
        └────┬─────┘ └────┬─────┘ └────┬─────┘
             │             │             │
             └─────────────┼─────────────┘
                           ▼
                    Shared MongoDB
```

### What Lives Where

| Component | Location | Why |
|-----------|----------|-----|
| **Authenticating** | Central gateway | Shared across all users, no isolation needed |
| **Sessioning** | Central gateway | Same — sessions are lightweight, no file I/O |
| **Profiling** | Central gateway | User profiles are shared data |
| **ProjectLedger** | Central gateway (+ shared DB) | Needs to list projects without spinning up a container |
| **Sandboxing** | Central gateway | Manages container lifecycle |
| **Planning** | Sandbox container | Calls DSPy, benefits from env-level API key |
| **ConceptDesigning** | Sandbox container | Calls DSPy |
| **Implementing** | Sandbox container | Writes temp files, runs tests — **must be isolated** |
| **SyncGenerating** | Sandbox container | Calls DSPy |
| **Assembling** | Sandbox container | Writes project files, zips — benefits from isolation |
| **FrontendGenerating** | Sandbox container | Runs `npx ts-node`, resource intensive, creates artifacts |

### Key Principle: Pipeline Concepts Are Unchanged

The existing pipeline concepts (Planning, ConceptDesigning, Implementing, SyncGenerating, Assembling, FrontendGenerating) already:
- Read `GEMINI_API_KEY` from environment
- Write to local filesystem for test runs
- Persist pipeline state to MongoDB

**Zero changes needed.** The only difference is that they now run inside a Docker container instead of on the host, and the Gemini key arrives via `docker run -e` instead of a `.env` file.

---

## New Concept: Sandboxing

```markdown
### Concept: Sandboxing [User]

**purpose**
Provide isolated compute environments so each user gets their own filesystem and
environment variables, preventing interference between concurrent sessions.

**operational principle**
After a user authenticates and initiates pipeline work, a sandbox is provisioned
with their Gemini API key injected as an environment variable. All pipeline
requests for that user route to their sandbox.

**Resource Optimizations:**
- Sandboxes are provisioned with resources appropriate for the active task. Heavy tasks (FrontendGenerating) receive 2GB+ RAM; lighter tasks receive less.
- **Persistence:** Active sandboxes are NEVER reaped while a task (Implementing, Generating) is processing, even if the user disconnects. The sandbox persists until completion and state update.
- **Queuing:** If host resources are exhausted, new provisioning requests enter a FIFO queue.

When the pipeline completes or the user is idle (and no task is running), the sandbox is torn down. Persistent state (plans, designs, implementations) survives in the shared database.

**state (SSF)**
a set of Sandboxes with
  a sandbox ID
  a user ID
  a containerId String
  an endpoint String (host:port)
  a status String (provisioning|ready|idle|error|terminated)
  a createdAt DateTime
  a lastActiveAt DateTime

**actions**

* **provision (user: userID, apiKey: String) : (sandbox: sandboxID, endpoint: String)**
  requires: no active sandbox for user
  effects: starts Docker container with apiKey in env and shared MongoDB URI,
           records containerId and endpoint, sets status="provisioning" then "ready"

* **touch (sandbox: sandboxID) : (ok: Flag)**
  requires: sandbox exists and is active
  effects: updates lastActiveAt timestamp

* **teardown (sandbox: sandboxID) : (ok: Flag)**
  requires: sandbox exists
  effects: stops and removes Docker container, sets status="terminated"

* **reap () : (reaped: Number)**
  effects: finds all sandboxes with lastActiveAt older than IDLE_TIMEOUT AND status != "processing",
           calls teardown on each, returns count reaped

**queries**
`_getEndpoint(user: userID) : (endpoint: String | null)`
`_isActive(user: userID) : (active: Flag)`
`_getStatus(sandbox: sandboxID) : (status: String)`
`_getActiveSandboxes() : (sandboxes: Array<Sandbox>)`
```

---

## API Key Security

### Threat Model

The user's Gemini API key must:
- **Never** be written to MongoDB or any persistent store
- **Never** appear in application logs (stdout/stderr)
- Live only for the duration of the user's active session
- Be inaccessible to other users

### How the Key Flows

```
Frontend                    Central Gateway              Docker Container
   │                              │                              │
   │  POST /sandbox/provision     │                              │
   │  Header: x-gemini-key: sk-.. │                              │
   │  Header: Authorization: tok  │                              │
   │ ─────────────────────────────>│                              │
   │                              │                              │
   │                              │  docker run -e GEMINI_API_   │
   │                              │  KEY=sk-.. (via Docker API)  │
   │                              │ ─────────────────────────────>│
   │                              │                              │
   │                              │  Key now in container env    │
   │                              │  Gateway discards key from   │
   │                              │  memory immediately          │
   │                              │                              │
   │  POST /projects (pipeline)   │                              │
   │ ─────────────────────────────>│                              │
   │                              │  proxy to container endpoint │
   │                              │ ─────────────────────────────>│
   │                              │                              │
   │                              │  Container reads GEMINI_API_ │
   │                              │  KEY from its own env, passes│
   │                              │  to DSPy Python processes    │
```

### Security Measures

| Measure | Implementation |
|---------|---------------|
| **Transport encryption** | HTTPS between frontend and gateway (mandatory in production) |
| **Key in header, not body** | Avoids key appearing in request body logs; gateway strips header before any logging |
| **Gateway discards immediately** | After passing to `docker run -e`, the gateway nulls the variable; no in-memory retention |
| **Container env only** | Key exists only as env var in the container process; not written to any file inside container |
| **No Docker inspect exposure** | In production, use Docker secrets or a secrets manager instead of `-e` for env vars |
| **Log sanitization** | All DSPy Python scripts must never print env vars; Deno server must never log request headers containing the key |
| **Ephemeral by design** | Container is torn down after completion or idle timeout; key ceases to exist |
| **No persistence** | Sandboxing concept stores `sandboxId`, `endpoint`, `status` in MongoDB — **never** the API key |

### Residual Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| `docker inspect` exposes env vars to host admin | Low (requires host access) | Use Docker secrets in production; in dev, acceptable |
| Container left running indefinitely leaks key | Medium | Reaper cron job runs every 5 minutes; hard max lifetime of 2 hours (unless processing) |
| DSPy process crashes and dumps env to stderr | Medium | Wrap all Python subprocess calls in try/except; sanitize stderr before logging |
| Gateway crash between receiving key and starting container | Low | Key is in-memory only; crash loses it, user re-submits; no persistent leak |
| Frontend stores key insecurely | Out of scope | Recommend: hold key in component state only, never localStorage; clear on tab close |

### Production Hardening (Future)

For a production deployment, replace `-e GEMINI_API_KEY=...` with Docker secrets:

```bash
echo "sk-user-key" | docker secret create user_gemini_key_<sandboxId> -
docker service create --secret user_gemini_key_<sandboxId> ...
```

The secret is mounted as a file at `/run/secrets/user_gemini_key_<sandboxId>` inside the container and never appears in `docker inspect`. This requires Docker Swarm or equivalent (Kubernetes secrets work similarly).

For now (dev/small deployment): **`-e` is acceptable** as long as the reaper runs and you trust your host environment.

---

## Sync Flows

### Sandbox Provisioning

```
sync ProvisionSandbox
when
  Requesting.request(path="/sandbox/provision", method="POST", accessToken, geminiKey)
where
  Sessioning._getSession(accessToken) => (userId)
  Sandboxing._isActive(userId) => (active)
  active == false
then
  Sandboxing.provision(userId, geminiKey)

sync SandboxReady
when
  Sandboxing.provision => (sandboxId, endpoint, status="ready")
then
  Requesting.respond(request, { status: "ready", sandboxId, endpoint })

sync SandboxProvisionFailed
when
  Sandboxing.provision => (sandboxId, status="error", error)
then
  Requesting.respond(request, { status: "error", error })
```

### Request Proxying (Pipeline Routes)

```
sync ProxyPipelineRequest
when
  Requesting.request(path="/projects/:projectId/*", accessToken)
where
  Sessioning._getSession(accessToken) => (userId)
  Sandboxing._getEndpoint(userId) => (endpoint)
  endpoint != null
then
  Sandboxing.touch(sandboxId)
  Requesting.proxy(request, endpoint)

sync NoActiveSandbox
when
  Requesting.request(path="/projects/:projectId/*", accessToken)
where
  Sessioning._getSession(accessToken) => (userId)
  Sandboxing._getEndpoint(userId) => (endpoint)
  endpoint == null
then
  Requesting.respond(request, { status: "sandbox_required",
    message: "Please provision a sandbox with your API key first" })
```

### Project Listing (No Sandbox Needed)

```
sync ListProjects
when
  Requesting.request(path="/projects", method="GET", accessToken)
where
  Sessioning._getSession(accessToken) => (userId)
then
  ProjectLedger._getProjects(userId)

sync ListProjectsResult
when
  ProjectLedger._getProjects => (projects)
then
  Requesting.respond(request, { projects })
```

### Resuming a Half-Finished Project

```
sync ResumeProject
when
  Requesting.request(path="/projects/:projectId/resume", method="POST", accessToken, geminiKey)
where
  Sessioning._getSession(accessToken) => (userId)
  ProjectLedger._getProject(projectId) => (project)
  project.owner == userId
  Sandboxing._isActive(userId) => (active)
  active == false
then
  Sandboxing.provision(userId, geminiKey)
  // Once sandbox is ready, frontend hits the appropriate pipeline
  // endpoint; sandbox loads existing state from shared MongoDB
```

The sandbox container doesn't need to know it's "resuming." It connects to MongoDB, and when the frontend hits (for example) `POST /projects/:projectId/implement`, the Implementing concept loads the existing design from the DB for that projectId and picks up where it left off. The ProjectLedger status field tells the frontend which step to trigger next.

### Sandbox Teardown

```
sync TeardownOnCompletion
when
  Assembling.assemble => (projectId, downloadUrl)
then
  ProjectLedger.updateStatus(projectId, "complete")
  // Sandbox stays alive briefly for download, then idle timeout reaps it

sync IdleReaper
when
  Timer.tick(interval="5m")
then
  Sandboxing.reap()

sync ManualTeardown
when
  Requesting.request(path="/sandbox/teardown", method="POST", accessToken)
where
  Sessioning._getSession(accessToken) => (userId)
  Sandboxing._isActive(userId) => (active)
  active == true
then
  Sandboxing.teardown(userId)
```

---

## Implementation Plan

### Phase 1: Sandbox Infrastructure (Days 1–3)

**Goal:** Sandboxing concept works; can provision and teardown containers.

**Tasks:**

- [ ] Create the sandbox container Docker image:
  ```
  conceptual-ai/
  ├── Dockerfile.sandbox        # Pipeline image (Deno + Python + DSPy)
  ├── Dockerfile.gateway        # Central gateway image
  ├── docker-compose.yml        # For local dev
  └── src/
      ├── gateway/              # Central gateway (NEW)
      │   ├── main.ts
      │   ├── concepts/
      │   │   ├── Authenticating/
      │   │   ├── Sessioning/
      │   │   ├── Profiling/
      │   │   ├── ProjectLedger/
      │   │   └── Sandboxing/
      │   │       ├── SandboxingConcept.ts
      │   │       ├── Sandboxing.md
      │   │       └── Sandboxing.test.ts
      │   └── syncs/
      │       └── index.ts
      └── sandbox/              # Pipeline image (EXISTING code, mostly unchanged)
          ├── main.ts
          ├── concepts/
          │   ├── Requesting/
          │   ├── Planning/
          │   ├── ConceptDesigning/
          │   ├── Implementing/
          │   ├── SyncGenerating/
          │   └── Assembling/
          └── syncs/
              └── index.ts
  ```

- [ ] Write `Dockerfile.sandbox`:
  ```dockerfile
  FROM denoland/deno:2.1.4

  USER root
  RUN apt-get update && \
      apt-get install -y python3 python3-pip python3-venv nodejs npm && \
      rm -rf /var/lib/apt/lists/*

  RUN python3 -m venv /opt/venv
  ENV PATH="/opt/venv/bin:$PATH"

  COPY src/sandbox/requirements.txt /app/requirements.txt
  RUN pip install --no-cache-dir -r /app/requirements.txt

  WORKDIR /app
  COPY src/sandbox/ .
  RUN deno cache main.ts

  EXPOSE 8000

  # GEMINI_API_KEY and MONGO_URI injected at runtime via -e
  CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-run", \
       "--allow-read", "--allow-write", "main.ts"]
  ```

- [ ] Write `Dockerfile.gateway`:
  ```dockerfile
  FROM denoland/deno:2.1.4

  WORKDIR /app
  COPY src/gateway/ .
  RUN deno cache main.ts

  EXPOSE 3000

  CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-run", \
       "--allow-read", "main.ts"]
  ```

- [ ] Implement `SandboxingConcept.ts`:
  ```typescript
  import { Db, Collection } from "npm:mongodb";
  import { ID } from "@utils/types.ts";

  export type User = ID;

  const PREFIX = "Sandboxing" + ".";

  interface SandboxState {
    _id: ID;
    userId: User;
    containerId: string;
    endpoint: string;
    status: "provisioning" | "ready" | "idle" | "error" | "terminated";
    createdAt: Date;
    lastActiveAt: Date;
  }

  const IDLE_TIMEOUT_MS = 30 * 60 * 1000;   // 30 minutes
  const MAX_LIFETIME_MS = 2 * 60 * 60 * 1000; // 2 hours

  export default class SandboxingConcept {
    sandboxes: Collection<SandboxState>;

    constructor(private readonly db: Db) {
      this.sandboxes = this.db.collection<SandboxState>(PREFIX + "sandboxes");
    }

    async provision({ userId, apiKey }: { userId: User; apiKey: string }) {
      // Check no active sandbox
      const existing = await this.sandboxes.findOne({
        userId, status: { $in: ["provisioning", "ready"] }
      });
      if (existing) return { error: "Active sandbox already exists" };

      const port = await this.findAvailablePort();
      const sandboxId = crypto.randomUUID();

      // Start container — apiKey passed ONLY here, never stored
      const command = new Deno.Command("docker", {
        args: [
          "run", "-d",
          "--name", `sandbox-${sandboxId}`,
          "-p", `${port}:8000`,
          "-e", `GEMINI_API_KEY=${apiKey}`,
          "-e", `MONGO_URI=${Deno.env.get("MONGO_URI")}`,
          "--rm",
          "conceptualai-sandbox:latest",
        ],
        stdout: "piped",
        stderr: "piped",
      });

      // apiKey is NOT stored anywhere after this point
      const output = await command.output();
      const containerId = new TextDecoder()
        .decode(output.stdout).trim();

      if (!output.success) {
        return { error: "Failed to start sandbox" };
      }

      await this.sandboxes.insertOne({
        _id: sandboxId,
        userId,
        containerId,
        endpoint: `http://localhost:${port}`,
        status: "ready",
        createdAt: new Date(),
        lastActiveAt: new Date(),
      });

      return { sandboxId, endpoint: `http://localhost:${port}` };
    }

    async touch({ sandboxId }: { sandboxId: ID }) {
      await this.sandboxes.updateOne(
        { _id: sandboxId },
        { $set: { lastActiveAt: new Date() } }
      );
      return { ok: true };
    }

    async teardown({ sandboxId }: { sandboxId: ID }) {
      const sandbox = await this.sandboxes.findOne({ _id: sandboxId });
      if (!sandbox) return { error: "Sandbox not found" };

      await new Deno.Command("docker", {
        args: ["stop", `sandbox-${sandboxId}`],
      }).output();

      await this.sandboxes.updateOne(
        { _id: sandboxId },
        { $set: { status: "terminated" } }
      );

      return { ok: true };
    }

    async reap() {
      const cutoff = new Date(Date.now() - IDLE_TIMEOUT_MS);
      const hardCutoff = new Date(Date.now() - MAX_LIFETIME_MS);

      // Check "busy" status before reaping
      // Note: This requires SandboxingConcept to query the status of active jobs
      // or for jobs to report "processing" status to the sandbox record.
      // For MVP, we assume if lastActiveAt is recent, it's busy.
      // Ideally, check ProjectLedger for "processing" status for this user.

      const stale = await this.sandboxes.find({
        status: { $in: ["ready", "idle"] },
        $or: [
          { lastActiveAt: { $lt: cutoff } },
          { createdAt: { $lt: hardCutoff } } // Hard limit unless explicitly busy
        ]
      }).toArray();

      for (const sandbox of stale) {
         // TODO: Check if user has active processing job in ProjectLedger before reaping
        await this.teardown({ sandboxId: sandbox._id });
      }

      return { reaped: stale.length };
    }

    async _getEndpoint({ userId }: { userId: User }) {
      const sandbox = await this.sandboxes.findOne({
        userId, status: "ready"
      });
      return sandbox?.endpoint ?? null;
    }

    async _isActive({ userId }: { userId: User }) {
      const sandbox = await this.sandboxes.findOne({
        userId, status: { $in: ["provisioning", "ready"] }
      });
      return !!sandbox;
    }
  }
  ```

- [ ] Write `Sandboxing.test.ts` covering:
  - Provisioning creates a container and records endpoint
  - Double-provision for same user is rejected
  - Teardown stops container and updates status
  - Reaper finds and removes idle sandboxes
  - `_getEndpoint` returns null after teardown
  - Touch updates `lastActiveAt`

---

### Phase 2: Gateway & Proxying (Days 4–5)

**Goal:** Central gateway handles auth locally and proxies pipeline requests to sandbox containers.

**Tasks:**

- [ ] Implement gateway `Requesting` concept with route classification:
  ```typescript
  // Routes handled locally by the gateway
  const LOCAL_ROUTES = [
    "POST /auth/register",
    "POST /auth/login",
    "POST /auth/logout",
    "GET  /projects",           // list projects — no sandbox needed
    "GET  /projects/:id/status", // check status — no sandbox needed
    "POST /sandbox/provision",
    "POST /sandbox/teardown",
  ];

  // Routes proxied to user's sandbox
  const PROXIED_ROUTES = [
    "POST /projects",                      // create project (starts pipeline)
    "POST /projects/:id/clarify",
    "PUT  /projects/:id/plan",
    "POST /projects/:id/design",
    "POST /projects/:id/implement",
    "POST /projects/:id/generate-syncs",
    "POST /projects/:id/assemble",
    "POST /projects/:id/generate-frontend",
    "GET  /projects/:id/download",
    "GET  /projects/:id/plan",
    "GET  /projects/:id/design",
    "GET  /projects/:id/implementations",
  ];
  ```

- [ ] Implement proxy logic in gateway syncs:
  ```typescript
  async function proxyToSandbox(
    request: Request,
    endpoint: string
  ): Promise<Response> {
    const url = new URL(request.url);
    const targetUrl = `${endpoint}${url.pathname}${url.search}`;

    // Forward request, strip the x-gemini-key header (should not be present
    // on pipeline requests, but strip defensively)
    const headers = new Headers(request.headers);
    headers.delete("x-gemini-key");

    const proxyResponse = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
    });

    return proxyResponse;
  }
  ```

- [ ] Wire up gateway syncs (see Sync Flows section above)

- [ ] Implement health check for sandbox readiness:
  ```typescript
  async waitForSandboxReady(endpoint: string, maxWaitMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const res = await fetch(`${endpoint}/health`);
        if (res.ok) return true;
      } catch { /* container not ready yet */ }
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }
  ```

- [ ] Add `/health` endpoint to sandbox container's Requesting concept

- [ ] Test: gateway proxies a request to a sandbox and gets a response

---

### Phase 3: Sandbox Image & Pipeline Wiring (Days 6–7)

**Goal:** Existing pipeline concepts run inside the Docker image and connect to shared MongoDB.

**Tasks:**

- [ ] Modify sandbox `main.ts` to accept `MONGO_URI` from environment:
  ```typescript
  // This is likely the ONLY change to existing pipeline code
  const mongoUri = Deno.env.get("MONGO_URI") ?? "mongodb://localhost:27017";
  const client = new MongoClient(mongoUri);
  ```
  (If the existing code already reads `MONGO_URI` from env, no change needed at all.)

- [ ] Verify all pipeline concepts work inside the container:
  - [ ] Planning calls DSPy with `GEMINI_API_KEY` from env ✓ (already does this)
  - [ ] ConceptDesigning calls DSPy with `GEMINI_API_KEY` ✓
  - [ ] Implementing writes to local `/tmp` ✓ (now isolated per container)
  - [ ] SyncGenerating calls DSPy ✓
  - [ ] Assembling writes project files and zips ✓

- [ ] Build and test the sandbox image locally:
  ```bash
  docker build -f Dockerfile.sandbox -t conceptualai-sandbox:latest .
  docker run -e GEMINI_API_KEY=test -e MONGO_URI=mongodb://host.docker.internal:27017/conceptualai -p 8000:8000 conceptualai-sandbox:latest
  ```

- [ ] Test a full pipeline run inside a container manually:
  - Create project → Planning (with clarification) → Design → Implement → SyncGen → Assemble → Download

---

### Phase 4: Resume Flow & Reaper (Days 8–9)

**Goal:** Users can resume half-finished projects; idle sandboxes are automatically cleaned up.

**Tasks:**

- [ ] Implement resume flow in frontend:
  ```
  1. User logs in → GET /projects → sees list with statuses
  2. User picks project with status="designing"
  3. Frontend prompts for Gemini API key (if no active sandbox)
  4. POST /sandbox/provision with key
  5. Once ready, frontend hits POST /projects/:id/design
     (or whichever step corresponds to the status)
  6. Sandbox loads existing plan from MongoDB, continues pipeline
  ```

- [ ] Add frontend logic to map ProjectLedger status to next action:
  ```typescript
  const NEXT_ACTION: Record<string, string> = {
    "planning":            "POST /projects/:id (re-initiate)",
    "awaiting_clarification": "show clarification UI",
    "planning_complete":   "POST /projects/:id/design",
    "designing":           "wait (in progress)",
    "design_complete":     "POST /projects/:id/implement",
    "implementing":        "wait (in progress)",
    "impl_complete":       "POST /projects/:id/generate-syncs",
    "syncing":             "wait (in progress)",
    "sync_complete":       "POST /projects/:id/assemble",
    "assembling":          "wait (in progress)",
    "complete":            "GET /projects/:id/download",
    "error":               "show error, offer retry",
  };
  ```

- [ ] Implement the reaper timer:
  ```typescript
  // In gateway main.ts
  setInterval(async () => {
    const result = await concepts.Sandboxing.reap();
    if (result.reaped > 0) {
      console.log(`Reaped ${result.reaped} idle sandboxes`);
    }
  }, 5 * 60 * 1000); // every 5 minutes
  ```

- [ ] Test idle timeout:
  - Provision sandbox, don't interact for 30+ minutes, verify it's torn down
  - Provision sandbox, verify hard max (2 hours) tears it down even if active

- [ ] Test resume:
  - Run pipeline to "designing" step, teardown sandbox
  - Re-provision sandbox, resume from "designing", verify it loads state from DB

---

### Phase 5: Docker Compose & Local Dev (Day 10)

**Goal:** Easy local development with `docker-compose up`.

**Tasks:**

- [ ] Write `docker-compose.yml`:
  ```yaml
  services:
    gateway:
      build:
        context: .
        dockerfile: Dockerfile.gateway
      ports:
        - "3000:3000"
      environment:
        - MONGO_URI=mongodb://mongo:27017/conceptualai
        - DOCKER_HOST=unix:///var/run/docker.sock
      volumes:
        - /var/run/docker.sock:/var/run/docker.sock  # gateway needs to manage containers
      depends_on:
        - mongo

    mongo:
      image: mongo:7
      ports:
        - "27017:27017"
      volumes:
        - mongodata:/data/db

    # Note: sandbox containers are NOT in compose — they are
    # dynamically created/destroyed by the Sandboxing concept.
    # But we pre-build the image:

  volumes:
    mongodata:
  ```

- [ ] Add a Makefile or script for building the sandbox image:
  ```bash
  # build.sh
  docker build -f Dockerfile.sandbox -t conceptualai-sandbox:latest .
  docker build -f Dockerfile.gateway -t conceptualai-gateway:latest .
  docker compose up
  ```

- [ ] Add `SANDBOX_IMAGE` env var to gateway so image name isn't hardcoded:
  ```typescript
  const SANDBOX_IMAGE = Deno.env.get("SANDBOX_IMAGE") ?? "conceptualai-sandbox:latest";
  ```

- [ ] Test full flow end-to-end via docker-compose

---

### Phase 6: Frontend Updates (Days 11–12)

**Goal:** Frontend handles sandbox lifecycle transparently.

**Tasks:**

- [ ] Add API key input UI:
  - Text input for Gemini API key on first pipeline action
  - Key stored in Vue reactive state only (never localStorage, never sent to backend except for provisioning)
  - Clear key from memory on logout or tab close

- [ ] Add sandbox status indicator:
  - Show "Sandbox: Active" / "Sandbox: Inactive" in UI
  - Show spinner during provisioning (1-5 second wait)

- [ ] Handle sandbox-required responses:
  - If any pipeline request returns `{ status: "sandbox_required" }`, prompt for API key and provision

- [ ] Handle sandbox timeout gracefully:
  - If a proxied request fails because sandbox was reaped, show message and re-prompt for key

- [ ] Update project list view:
  - Show project status badges
  - "Resume" button on incomplete projects
  - "Download" button on complete projects

---

## Checklist

```
Sandboxing Concept:
[ ] provision creates container with API key in env
[ ] API key is NEVER written to MongoDB
[ ] teardown stops and removes container
[ ] reap finds idle/expired sandboxes
[ ] touch updates lastActiveAt
[ ] _getEndpoint returns correct URL
[ ] _isActive returns correct state
[ ] Tests written and passing

Gateway:
[ ] Auth routes handled locally
[ ] Project list/status queries DB directly (no sandbox)
[ ] Pipeline routes proxied to sandbox endpoint
[ ] x-gemini-key header stripped on proxy
[ ] Health check waits for sandbox readiness
[ ] Reaper timer runs every 5 minutes

Docker Images:
[ ] Sandbox image builds with Deno + Python + DSPy
[ ] Gateway image builds
[ ] Sandbox connects to external MongoDB via MONGO_URI
[ ] GEMINI_API_KEY read from env (existing behavior)

Pipeline (should need ZERO changes):
[ ] Planning works in container
[ ] ConceptDesigning works in container
[ ] Implementing works in container (filesystem isolated)
[ ] SyncGenerating works in container
[ ] Assembling works in container
[ ] FrontendGenerating works in container
[ ] Node.js and npm installed in sandbox image

Resume Flow:
[ ] Frontend maps project status to next action
[ ] Provisioning sandbox for resumed project works
[ ] Pipeline concepts load existing state from shared DB
[ ] No data loss between sandbox teardown and re-provision

Security:
[ ] API key never in MongoDB
[ ] API key never in application logs
[ ] API key never in Docker logs (verify with docker logs)
[ ] HTTPS configured for production
[ ] Idle timeout works
[ ] Hard max lifetime works

Local Dev:
[ ] docker-compose up starts gateway + mongo
[ ] Sandbox image pre-built
[ ] Full e2e flow works locally
```

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Container startup latency (1-5s) | High | Low | Add loading spinner in frontend; consider pre-warming a pool of containers |
| Docker socket access is a security risk | Medium | High | In production, use a container orchestrator API (Kubernetes, Cloud Run) instead of raw Docker socket |
| User submits invalid API key | High | Medium | Sandbox does a lightweight Gemini API validation call on startup; return error fast |
| Too many concurrent containers exhaust host resources | Medium | High | Set MAX_CONCURRENT_SANDBOXES limit in Sandboxing concept; queue or reject beyond limit |
| Container crashes mid-pipeline | Medium | Medium | Pipeline state is in MongoDB; user can resume. Set project status to "error" on crash detection |
| Port collisions when assigning sandbox ports | Low | Medium | Use dynamic port assignment via Docker (`-p 0:8000`); read assigned port from `docker inspect` |
| MongoDB connection pooling from many containers | Medium | Medium | Use connection limits per container; monitor MongoDB connections |

---

## Future Improvements

- **Container pooling:** Pre-warm N containers without API keys; inject key at assignment time to eliminate startup latency
- **Kubernetes migration:** Replace Docker socket calls with Kubernetes pod creation for production scalability
- **WebSocket support:** Stream pipeline progress from sandbox to frontend in real-time instead of polling
- **Multi-project sandboxes:** Allow one sandbox to handle multiple projects for the same user (already works since projects are keyed by projectId in MongoDB)
- **Resource limits:** Add `--memory` and `--cpus` flags to `docker run` to prevent any single user from consuming excessive resources

---

## Critique & Risks (Added Review)

### Complexity of Central Gateway
The "Central Gateway" architecture with custom proxy logic adds significant complexity. It essentially reimplements a reverse proxy. A simpler approach might be to have the frontend talk directly to the sandbox if possible (though CORS and auth would be tricky), or use an off-the-shelf proxy. However, given the need to strip headers and manage lifecycle, the custom gateway might be unavoidable but is a high-effort component.

### Security: Docker Socket
Mounting `/var/run/docker.sock` into the Gateway container is a major security risk. If the Gateway is compromised, the attacker has root access to the host.
**Mitigation:** Use a proper orchestration API (Kubernetes, Docker Swarm, or a sidecar proxy that only allows specific Docker commands) instead of raw socket access. For MVP, this is acceptable but must be replaced for production.

### State Resumption & Persistence
The "resume" flow relies on `Implementing` and `FrontendGenerating` being stateless or fully checkpointed in MongoDB.
- **Persistence:** Sandboxes are NOT reaped if a task is actively processing. If a user disconnects during `Implementing`, the sandbox completes the work, updates MongoDB, and only THEN becomes eligible for reaping.
- **Reconnection:** If a user returns while a task is running, the frontend polls project status and reconnects to the *active* sandbox to show progress.
- **Resumption:** If a sandbox was reaped (after completion or idle), "Resume" simply provisions a new sandbox and loads the latest state from MongoDB.

### Resource Optimization
- **Task Sizing:** `FrontendGenerating` requires significantly more RAM (2GB+) than `Planning`. The provisioning logic (or re-provisioning logic at checkpoints) should allocate resources accordingly.
- **Queuing:** If the host is out of RAM, new sandbox requests are queued. This prevents OOM kills and ensures fairness.

### Frontend Generating Resource Usage
`FrontendGenerating` runs `npx ts-node` which is memory and CPU intensive. Running this inside the same container as the lightweight Deno server might cause OOM kills if the container limit is low.
**Mitigation:** Ensure the sandbox container has at least 2GB+ RAM. (Now handled by dynamic task sizing).

### Dependency Management
The `Dockerfile.sandbox` needs to include Node.js and npm for `FrontendGenerating`, not just Python and Deno.

