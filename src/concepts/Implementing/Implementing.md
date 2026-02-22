### Concept: Implementing [Project]

**purpose**
Generate TypeScript implementations and comprehensive tests for concepts, with automated fixing.

**principle**
Each concept is implemented with full test coverage; iterations continue until tests pass or max reached.

**state (SSF)**
a set of ImplJobs with
  a project ID
  a design Design
  a implementations Map<String, { code: String, tests: String, spec: String, status: String, iterations: Number }>
  a status String

**actions**

* **implementAll (project: projectID, design: Design) : (project: projectID, implementations: Object)**
  effects: 
    - for library pulls: fetches from Conceptual, renames class/files to instanceName
    - for custom concepts: generates impl + tests, runs test loop until pass

* **change (project: projectID, conceptName: String, feedback: String) : (project: projectID, implementations: Object)**
  requires: implementation exists for conceptName
  effects: re-runs implementation loop for specific concept with feedback

* **delete (project: projectID, conceptName: String) : (project: projectID, implementations: Object)**
  requires: implementation exists for conceptName
  effects: removes implementation for conceptName

* **deleteProject (project: projectID) : (deleted: Number)**
  effects: removes all implementation artifacts for the project

**queries**
`_getImplementations(project: projectID) : (implementations: Object)`
