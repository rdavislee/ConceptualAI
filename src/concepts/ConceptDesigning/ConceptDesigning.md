### Concept: ConceptDesigning [Project]

**purpose**
Select library concepts and write specs for custom concepts, given a plan.

**principle**
All concepts for an app are determined in one pass; library concepts can be duplicated with different names.

**state (SSF)**
a set of Designs with
  a project ID
  a plan Object
  a libraryPulls Array<{ libraryName: String, instanceName: String, bindings: Object }>
  a customConcepts Array<{ name: String, spec: String }>
  a status String

**actions**

* **design (project: projectID, plan: Object) : (project: projectID, design: Design)**
  requires: no design exists for project
  effects: calls DSPy agent with plan + all library specs, stores result

* **delete (project: projectID) : (ok: Flag)**
  requires: design exists
  effects: deletes the design

**queries**
`_getDesign(project: projectID) : (design: Design)`

