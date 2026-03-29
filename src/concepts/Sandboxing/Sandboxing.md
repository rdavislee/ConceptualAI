### Concept: Sandboxing [User]

**purpose**
Provide isolated, secure, and ephemeral compute environments using Docker containers for executing sensitive or resource-intensive logic (like agentic planning and implementation).

**principle**
A sandbox is provisioned for a specific user to run isolated tasks. The system ensures the sandbox is healthy and reachable before use. Sandboxes are automatically reaped after a period of inactivity to conserve resources.

**state (SSF)**
a set of Sandboxes with
  a userId User
  a containerId String (Docker ID)
  an endpoint String (URL to the sandbox service)
  a status String (provisioning|ready|idle|error|terminated)
  a createdAt DateTime
  a lastActiveAt DateTime

**actions**

* **provision (userId: User, apiKey: String) : (sandboxId: ID, endpoint: String)**
  requires: no active sandbox for user OR existing container is healthy
  effects:
    - Finds an available host port
    - Starts a Docker container with `apiKey`, `MONGODB_URL`, and `DB_NAME` in environment
    - Passes `SANDBOX_ID` into the container so in-sandbox handoffs can heartbeat the host record
    - Uses a resettable idle watchdog tied to `lastActiveAt` instead of one fixed process timeout
    - Records the sandbox state in the database
  returns: sandboxId and the host-reachable endpoint

* **touch (sandboxId: ID) : (ok: Flag)**
  requires: sandbox exists and is active
  effects: updates `lastActiveAt` timestamp to prevent premature reaping

* **teardown (sandboxId: ID) : (ok: Flag)**
  requires: sandbox exists
  effects: stops and removes the Docker container, sets status to "terminated"

* **reap () : (reaped: Number)**
  effects: identifies and terminates sandboxes that have stopped heartbeating
    - `ready` / `idle` sandboxes are reaped after 30 minutes without activity
    - `provisioning` sandboxes are reaped after 2 hours without a heartbeat

**queries**
`_getEndpoint(userId: User) : (endpoint: String | null)`
`_isActive(userId: User) : (active: Boolean)`

### Implementation Details

**Docker Isolation**
The concept uses Docker to wrap the Entire ConceptualAI stack (or a subset) into a sandbox.
- **Image**: `conceptualai-sandbox:latest` (built from `Dockerfile.sandbox`)
- **Isolation**: Each user gets a dedicated container, preventing cross-tenant data leakage or resource interference.
- **Port Management**: Dynamic host port selection from the range 10001-11000.

**Reliability**
- **Lifecycle Watchdog**: Long-lived chained pipelines stay alive as long as they keep touching `lastActiveAt`; there is no separate creation-time hard cutoff.
- **Idempotency**: `provision` detects if a container is already running and returns the healthy endpoint instead of starting a new one.
- **Auto-Cleanup**: The `reap` action should be called periodically (e.g., via a cron job or background loop) to manage resource lifecycle.

**Security**
- **API Keys**: Keys are passed ONLY as environment variables during `docker run`. They are never stored in the database.
- **Container Cleanup**: Containers are started with `--rm` to ensure filesystem cleanup upon exit.
