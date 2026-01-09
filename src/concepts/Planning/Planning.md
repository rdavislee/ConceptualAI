### Concept: Planning [Project]

**purpose**
Generate an app plan from a description, asking clarifying questions when needed.

**principle**
Planning either completes with a plan or pauses for clarification; clarifications resume planning.

**state (SSF)**
a set of Plans with
  a project ID
  a description String
  an optional plan Object
  an optional questions Array<String>
  a status String (processing|needs_clarification|complete|error)
  a clarifications Array<Object> (history of Q&A)
  a createdAt DateTime

**actions**

* **initiate (project: projectID, description: String) : (project: projectID, status: String, plan?: Object, questions?: Array<String>)**
  requires: no plan exists for project
  effects: calls DSPy planner, stores result
  returns: status + either plan (if complete) or questions (if needs clarification)

* **clarify (project: projectID, answers: Object) : (project: projectID, status: String, plan?: Object, questions?: Array<String>)**
  requires: plan exists with status="needs_clarification"
  effects: adds to clarifications, re-runs planner with context
  returns: status + either plan or more questions

**queries**
`_getPlan(project: projectID) : (plan: Plan)`
`_getStatus(project: projectID) : (status: String)`

### Implementation Details

**DSPy Agent Service**
The planning logic is handled by a Python DSPy service located in `src/concepts/Planning/dspy/`.
- **Architecture**: The `PlanningConcept` executes the python script `src/concepts/Planning/dspy/main.py` as a subprocess for each request (via `Deno.Command`). This ensures zero idle resource usage.
- **Data Flow**: `PlanningConcept` -> `stdin` (JSON) -> `python` -> `stdout` (JSON) -> `PlanningConcept`.
- **Development**: Use `python src/concepts/Planning/test_planner_cli.py` to test the agent interactively. The CLI imports the planner logic directly.
