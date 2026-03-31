### Concept: GitHubExporting [Project, Artifact]

**purpose**
Create a GitHub repository for a single generated artifact and track export status, repository metadata, and sanitized logs for polling.

**principle**
Backend and frontend exports are independent jobs. Export never creates a combined repository. Each job creates one repository from one stored build artifact when the user explicitly requests it. An artifact cannot be re-exported while its tracked repository still exists remotely, but a stale export can be retried if the repository was deleted on GitHub.

**state (SSF)**

```text
a set of ExportJobs with
  a project Project
  an artifact String
  a user User
  a repoName String
  a visibility String
  a status String
  an optional repoUrl String
  an optional repoOwner String
  an optional repoId String
  an optional remoteExists Flag
  an optional lastRemoteCheckAt DateTime
  a logs [String]
  a createdAt DateTime
  an updatedAt DateTime
```

**actions**

* **createExport(user: User, project: Project, artifact: String, repoName: String, visibility: String, status: String) : (ok: Flag) | (error: String)**
  requires: the artifact is `backend` or `frontend` and the repo name is valid
  effects: creates an export record for the artifact
* **updateExport(project: Project, artifact: String, patch: Object) : (ok: Flag) | (error: String)**
  requires: an export record exists
  effects: updates export metadata and status
* **checkRemoteExport(project: Project, artifact: String, accessToken: String) : (remoteExists: Flag) | (error: String)**
  requires: export metadata includes a tracked GitHub repo
  effects: checks whether the tracked repo still exists on GitHub and updates cached remote metadata
* **startExport(user: User, project: Project, artifact: String, repoName: String, visibility: String, accessToken: String) : (status: String) | (error: String)**
  requires: the artifact zip exists and the tracked repo does not still exist remotely
  effects: creates or reuses the export record, then runs repo creation and initial git push in the background
* **deleteExport(project: Project, artifact: String) : (deleted: Number)**
  requires: true
  effects: deletes one export record
* **deleteProject(project: Project) : (deleted: Number)**
  requires: true
  effects: deletes all export records for a project

**queries**

* **_getExport(project: Project, artifact: String) : (job: ExportJob)**
* **_listExportsByProject(project: Project) : (job: ExportJob)**
* **_listExportsByUser(user: User) : (job: ExportJob)**

---
