### Concept: SyncGenerating [Project]

**purpose**
Generate synchronizations that wire concepts together for the application and produce an API definition.

**principle**
Syncs orchestrate concept interactions; all API requests flow through Requesting and the sync engine with no passthrough routes.

**state (SSF)**
a set of SyncJobs with
  a project ID
  a syncs Array<SyncDefinition>
  an apiDefinition Object (OpenAPI YAML)
  an endpointBundles Array<EndpointBundle>
  a status String

**actions**

* **generate (project: projectID, plan: Object, conceptSpecs: String, implementations: Object) : (project: projectID, syncs: Array, apiDefinition: Object, endpointBundles: Array)**
  effects: analyzes plan + concept specs, defines API (OpenAPI YAML), generates sync definitions and tests per endpoint

* **deleteProject (project: projectID) : (deleted: Number)**
  effects: removes all sync-generation artifacts for the project

**queries**
`_getSyncs(project: projectID) : (syncs: Object, apiDefinition: Object, endpointBundles: Array)`
