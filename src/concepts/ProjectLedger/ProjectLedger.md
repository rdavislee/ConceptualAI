### Concept: ProjectLedger [User, Project]

**purpose**
Track which projects belong to which users and their current status.

**principle**
A project belongs to exactly one user; users can have many projects.

**state (SSF)**
a set of Projects with
  a project ID
  an owner (user ID)
  a name String
  a description String
  a status String (planning|designing|implementing|syncing|assembling|complete|error)
  a createdAt DateTime
  an updatedAt DateTime

**actions**

* **create (owner: userID, project: projectID, name: String, description: String) : (project: projectID)**
  requires: project doesn't exist
  effects: creates project with status="planning", timestamps

* **updateStatus (project: projectID, status: String) : (ok: Flag)**
  requires: project exists
  effects: updates status and updatedAt

**queries**
`_getProjects(owner: userID) : (projects: Set<Project>)`
`_getProject(project: projectID) : (project: Project)`
`_getOwner(project: projectID) : (owner: userID)`