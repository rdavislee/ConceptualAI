### Concept: Assembling [Project]

**purpose**
Package all generated code into a downloadable, runnable project.

**principle**
Assembly creates a complete project structure with all dependencies configured, ready for deployment or local execution.

**state (SSF)**
```
a set of Assemblies with
  a project ID
  a projectPath String
  a downloadUrl String
  a status String (assembling|complete|error)
  a createdAt DateTime
```

**actions**

* **assemble (project: projectID, plan: Object, implementations: Object, syncs: Object) : (project: projectID, downloadUrl: String)**
  requires: project exists, previous phases complete
  effects: 
    - creates project structure
    - writes all concept files (spec, code, tests)
    - writes all sync files and tests
    - generates OpenAPI spec
    - generates README.md and API.md documentation via AI
    - zips the project
    - stores zip and returns download URL

**queries**
`_getDownloadUrl(project: projectID) : (downloadUrl: String)`
