### Concept: FrontendGenerating [Project]

**purpose**
Generate a downloadable frontend repository from project plan and API definition.

**principle**
Frontend generation runs as a job with lifecycle tracking so progress and output can be queried and downloaded safely.

**state (SSF)**
a set of FrontendJobs with
  a project ID
  a status String (processing|complete|error)
  a downloadUrl String (optional)
  a zipData Binary (optional)
  a logs Array<String>
  a createdAt DateTime
  an updatedAt DateTime

**actions**

* **generate (project: projectID, plan: Object, apiDefinition: Object) : (project: projectID, status: String, downloadUrl?: String)**
  effects: starts (or runs) frontend generation, stores job status, and writes downloadable artifact on success

* **deleteProject (project: projectID) : (deleted: Number)**
  effects: removes generated frontend artifacts for the project

**queries**
`_getJob(project: projectID) : (job: FrontendJob)`
`_getDownloadUrl(project: projectID) : (downloadUrl: String)`
