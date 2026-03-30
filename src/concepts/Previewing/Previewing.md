### Concept: Previewing [User, Project]

**purpose**
Launch and manage short-lived hosted previews for generated backend + frontend artifacts.

**principle**
Preview launch is asynchronous and replace-in-place: one active preview per project, with explicit teardown and TTL-based expiration.

**state (SSF)**
a set of Previews with
  a project ID
  an owner user ID
  a provider String
  a status String (processing|ready|error|expired|stopped)
  backend app id/url fields
  frontend app id/url fields
  a previewDbName String
  a launchId String
  an expiresAt DateTime
  a lastError String (optional)
  createdAt / updatedAt DateTime

**actions**

* **launch (project: projectID, owner: userID) : (project: projectID, status: "processing")**
  effects:
    - validates artifacts and quota
    - tears down existing preview for the project
    - starts async deployment pipeline

* **teardown (project: projectID) : (stopped: Number)**
  effects: tears down remote preview deployments and marks preview as stopped

* **deleteProject (project: projectID) : (deleted: Number)**
  effects: teardown + delete preview state for the project

* **reapExpired () : (reaped: Number)**
  effects: tears down and marks expired previews whose TTL elapsed

**queries**
`_getPreview(project: projectID) : (preview: PreviewDoc)`
`_getActiveByOwner(owner: userID) : (active: Number)`
