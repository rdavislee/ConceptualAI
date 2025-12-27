# ConceptualAI: 4-Week IAP Development Plan

> **Team:** Davis & Anthony  
> **Goal:** Build an AI-powered backend generator using concept-based architecture — dogfooding the same patterns the system generates.

## Project Overview

### What We're Building

ConceptualAI is built using the same concept + sync architecture it generates. This proves the architecture handles complex multi-step workflows and makes the codebase self-documenting.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         ConceptualAI Platform                            │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   User Input: "A recipe sharing app where users can post recipes,        │
│                comment, like recipes and like comments"                  │
│                              │                                           │
│                              ▼                                           │
│   ┌─────────────────────────────────────────────────────────────────┐   │
│   │              ConceptualAI Backend (Built with Concepts!)         │   │
│   │                                                                  │   │
│   │  Concepts:                                                       │   │
│   │  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │   │
│   │  │ Authenticat- │ │ ProjectLedg-│ │ Planning (DSPy inside)   │ │   │
│   │  │ ing          │ │ er          │ │ - can ask clarifications │ │   │
│   │  └──────────────┘ └──────────────┘ └──────────────────────────┘ │   │
│   │  ┌──────────────────────────────┐ ┌──────────────────────────┐ │   │
│   │  │ ConceptDesigning             │ │ Implementing             │ │   │
│   │  │ - selects library concepts   │ │ - generates code + tests │ │   │
│   │  │ - writes specs for new ones  │ │ - iteration loop to fix  │ │   │
│   │  │ - can duplicate with rename  │ │                          │ │   │
│   │  └──────────────────────────────┘ └──────────────────────────┘ │   │
│   │  ┌──────────────┐ ┌──────────────┐                             │   │
│   │  │ SyncGenerat- │ │ Assembling  │                              │   │
│   │  │ ing          │ │             │                              │   │
│   │  └──────────────┘ └──────────────┘                              │   │
│   │                                                                  │   │
│   │  Syncs: Wire concepts together, orchestrate the pipeline         │   │
│   └─────────────────────────────────────────────────────────────────┘   │
│                              │                                           │
│                              ▼                                           │
│   Output: Complete Deno/TypeScript backend with OpenAPI spec             │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Frontend (Vue)                                 │
│   - App description input                                                │
│   - Clarification Q&A interface                                          │
│   - Progress display                                                     │
│   - Download generated project                                           │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ HTTP
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              ConceptualAI Backend (Concepts + Syncs + Requesting)        │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                         Requesting Concept                       │    │
│  │   - HTTP entry point                                             │    │
│  │   - Routes to syncs or passthrough                               │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                     │                                    │
│                                     ▼                                    │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                            Syncs                                 │    │
│  │   - Orchestrate concept actions                                  │    │
│  │   - Handle auth checks                                           │    │
│  │   - Wire pipeline: Plan → Design → Implement → SyncGen → Assemble│   │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                     │                                    │
│         ┌───────────────────────────┼───────────────────────────┐       │
│         ▼                           ▼                           ▼       │
│  ┌─────────────┐  ┌─────────────────────────────┐  ┌─────────────────┐ │
│  │ Auth/       │  │ Pipeline Concepts           │  │ Assembling      │ │
│  │ Session/    │  │ (each wraps DSPy agent)     │  │                 │ │
│  │ Ledger      │  │                             │  │                 │ │
│  └─────────────┘  └─────────────────────────────┘  └─────────────────┘ │
│                                     │                                    │
└─────────────────────────────────────┼────────────────────────────────────┘
                                      │
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
          ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
          │  Conceptual  │  │   DSPy       │  │  Generated       │
          │  Library     │  │   Agents     │  │  Project Files   │
          │  Server      │  │   (Python)   │  │  (output/)       │
          └──────────────┘  └──────────────┘  └──────────────────┘
```

### Concept Inventory for ConceptualAI

| Concept | Purpose | State | Key Actions |
|---------|---------|-------|-------------|
| **Authenticating** | User authentication | credentials by userId | `register`, `login`, `verify` |
| **Sessioning** | Session management | sessions by token | `create`, `verify`, `revoke` |
| **ProjectLedger** | User ↔ Project mapping | projects by userId | `create`, `_getProjects`, `_getProject` |
| **Planning** | DSPy planning agent | plans by projectId | `initiate`, `clarify`, `_getPlan` |
| **ConceptDesigning** | Select library concepts + write custom specs | designs by projectId | `design`, `_getDesign` |
| **Implementing** | Generate code + tests, fix loop | implementations by projectId | `implementAll`, `_getImplementations` |
| **SyncGenerating** | Generate syncs + passthrough | syncs by projectId | `generate`, `_getSyncs` |
| **Assembling** | Package final project | assemblies by projectId | `assemble`, `_getDownloadUrl` |

### ConceptDesigning Output Format

The ConceptDesigning agent outputs both library pulls and custom specs in one pass:

```typescript
interface ConceptDesign {
  projectId: string;
  
  // Library concepts to pull (can have duplicates with different names)
  libraryPulls: Array<{
    libraryName: string;      // Name in Conceptual library (e.g., "Liking")
    instanceName: string;     // Name in this project (e.g., "PostLiking" or "CommentLiking")
    bindings: Record<string, string>;  // Generic param bindings (e.g., { Item: "Post", User: "User" })
  }>;
  
  // Custom concepts with full specs
  customConcepts: Array<{
    name: string;             // e.g., "Recipe"
    spec: string;             // Full markdown spec
  }>;
}

// Example output for "recipe app with post and comment liking":
{
  projectId: "abc123",
  libraryPulls: [
    { libraryName: "Authenticating", instanceName: "Authenticating", bindings: { User: "User" } },
    { libraryName: "Sessioning", instanceName: "Sessioning", bindings: { User: "User" } },
    { libraryName: "Posting", instanceName: "Posting", bindings: { Author: "User", Post: "Recipe" } },
    { libraryName: "Commenting", instanceName: "Commenting", bindings: { Item: "Recipe", Author: "User" } },
    { libraryName: "Liking", instanceName: "RecipeLiking", bindings: { Item: "Recipe", User: "User" } },
    { libraryName: "Liking", instanceName: "CommentLiking", bindings: { Item: "Comment", User: "User" } },
    { libraryName: "Following", instanceName: "Following", bindings: { Follower: "User", Followed: "User" } }
  ],
  customConcepts: [
    { name: "Recipe", spec: "### Concept: Recipe [Author]\n\n**purpose**\n..." }
  ]
}
```

### Key Sync Flows

**Project Creation & Planning:**
```
sync CreateProject
when 
  Requesting.request(path="/projects", method="POST", description, accessToken)
where 
  Sessioning._getSession(accessToken) => (userId)
  bind(uuid() as projectId)
then
  ProjectLedger.create(userId, projectId)
  Planning.initiate(projectId, description)

sync PlanningNeedsClarification
when 
  Planning.initiate => (projectId, status="needs_clarification", questions)
then 
  Requesting.respond(request, { status: "awaiting_input", questions })

sync PlanningComplete
when 
  Planning.initiate => (projectId, status="complete", plan)
then
  ConceptDesigning.design(projectId, plan)

sync UserProvidesClarification
when 
  Requesting.request(path="/projects/:projectId/clarify", answers, accessToken)
where
  Sessioning._getSession(accessToken) => (userId)
  ProjectLedger._getProject(projectId) => (ownerId)
  ownerId == userId
then
  Planning.clarify(projectId, answers)

sync ClarificationProcessed
when
  Planning.clarify => (projectId, status="complete", plan)
then
  ConceptDesigning.design(projectId, plan)
```

**Pipeline Continuation:**
```
sync DesignComplete
when
  ConceptDesigning.design => (projectId, design)
then
  Implementing.implementAll(projectId, design)

sync ImplementationComplete
when
  Implementing.implementAll => (projectId, implementations)
then
  SyncGenerating.generate(projectId)

sync SyncsGenerated
when
  SyncGenerating.generate => (projectId, syncs)
then
  Assembling.assemble(projectId)

sync AssemblyComplete
when
  Assembling.assemble => (projectId, downloadUrl)
then
  Requesting.respond(request, { status: "complete", downloadUrl })
```

---

## Week 1: Infrastructure & Core Concepts

**Hours Budget:** 60 hours combined  
**Theme:** Set up the concept-based backend and get planning working with clarifications

### Goals
- [ ] ConceptualAI backend running with Requesting concept
- [ ] ProjectLedger concept for user ↔ project mapping
- [ ] Planning concept wrapping DSPy (with clarification flow)
- [ ] Frontend can create project, receive clarification questions, answer them
- [ ] Conceptual library server running (headless)

### Days 1-2: Project Setup & Core Infrastructure

**ConceptualAI Backend Structure:**
```
conceptual-ai/
├── src/
│   ├── main.ts                     # Entry point, starts Requesting server
│   ├── concepts/
│   │   ├── index.ts                # Exports all concepts
│   │   ├── Requesting/             # (existing pattern)
│   │   ├── Authenticating/         # (existing pattern)
│   │   ├── Sessioning/             # (existing pattern)
│   │   ├── ProjectLedger/
│   │   │   ├── ProjectLedgerConcept.ts
│   │   │   └── ProjectLedger.md
│   │   └── Planning/
│   │       ├── PlanningConcept.ts
│   │       ├── Planning.md
│   │       └── dspy/               # Python DSPy agent
│   │           ├── main.py
│   │           ├── planner.py
│   │           └── requirements.txt
│   ├── syncs/
│   │   └── index.ts                # All sync definitions
│   └── utils/
├── deno.json
└── .env
```

**Tasks:**
- [ ] Initialize ConceptualAI repo with standard concept structure
- [ ] Copy Requesting, Authenticating, Sessioning from existing library
- [ ] Set up MongoDB connection
- [ ] Verify basic server starts and passthrough works

---

### Days 2-3: ProjectLedger Concept

**Spec: ProjectLedger**
```markdown
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
```

**Tasks:**
- [ ] Implement ProjectLedgerConcept.ts
- [ ] Write ProjectLedger.test.ts covering all actions and queries
- [ ] Run tests, fix any issues

---

### Days 3-5: Planning Concept with DSPy

**Spec: Planning**
```markdown
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
```

**Tasks:**
- [ ] Set up Python DSPy agent for planning:
  ```
  src/concepts/Planning/dspy/
  ├── main.py              # FastAPI wrapper
  ├── planner.py           # DSPy signatures and modules
  └── requirements.txt
  ```
- [ ] Create PlanningSignature that can request clarification:
  ```python
  class PlanningSignature(dspy.Signature):
      """Analyze app description and either produce a plan or ask clarifying questions."""
      
      app_description: str = dspy.InputField()
      available_concepts: str = dspy.InputField()
      clarification_history: str = dspy.InputField(desc="Previous Q&A, empty if first pass")
      
      needs_clarification: bool = dspy.OutputField(desc="True if questions needed")
      questions: list[str] = dspy.OutputField(desc="Questions to ask user, empty if not needed")
      plan: dict = dspy.OutputField(desc="The plan, empty if clarification needed")
  ```
- [ ] Implement PlanningConcept.ts that calls Python agent
- [ ] Write Planning.test.ts
- [ ] Test planning with clear and ambiguous inputs

---

### Days 5-6: Syncs for Planning Flow

**Tasks:**
- [ ] Write syncs for project creation and planning:
  ```typescript
  // src/syncs/index.ts
  
  export const syncs = [
    {
      name: "CreateProject",
      when: {
        "Requesting.request": { 
          path: "/projects", 
          name: "?name",
          description: "?description",
          accessToken: "?token"
        }
      },
      where: async (bindings, concepts) => {
        const session = await concepts.Sessioning._getSession({ token: bindings.token });
        if (!session[0]?.userId) return null;
        return { ...bindings, userId: session[0].userId, projectId: freshID() };
      },
      then: [
        ["ProjectLedger.create", { owner: "?userId", project: "?projectId", name: "?name", description: "?description" }],
        ["Planning.initiate", { project: "?projectId", description: "?description" }]
      ]
    },
    
    {
      name: "PlanningNeedsClarification",
      when: {
        "Planning.initiate": { status: "needs_clarification", project: "?projectId", questions: "?questions" }
      },
      then: [
        ["ProjectLedger.updateStatus", { project: "?projectId", status: "awaiting_clarification" }],
        ["Requesting.respond", { request: "?request", status: "awaiting_input", questions: "?questions" }]
      ]
    },
    
    {
      name: "PlanningComplete",
      when: {
        "Planning.initiate": { status: "complete", project: "?projectId", plan: "?plan" }
      },
      then: [
        ["ProjectLedger.updateStatus", { project: "?projectId", status: "designing" }],
        ["ConceptDesigning.design", { project: "?projectId", plan: "?plan" }]
      ]
    },
    
    {
      name: "UserClarifies",
      when: {
        "Requesting.request": {
          path: "/projects/:projectId/clarify",
          answers: "?answers",
          accessToken: "?token"
        }
      },
      where: async (bindings, concepts) => {
        const session = await concepts.Sessioning._getSession({ token: bindings.token });
        const owner = await concepts.ProjectLedger._getOwner({ project: bindings.projectId });
        if (session[0]?.userId !== owner[0]?.owner) return null;
        return bindings;
      },
      then: [
        ["Planning.clarify", { project: "?projectId", answers: "?answers" }]
      ]
    },
    
    {
      name: "ClarificationComplete",
      when: {
        "Planning.clarify": { status: "complete", project: "?projectId", plan: "?plan" }
      },
      then: [
        ["ProjectLedger.updateStatus", { project: "?projectId", status: "designing" }],
        ["ConceptDesigning.design", { project: "?projectId", plan: "?plan" }]
      ]
    }
  ];
  ```
- [ ] Configure passthrough.ts to exclude project routes (they go through syncs)
- [ ] Test the full planning flow manually

---

### Days 6-7: Conceptual Library Server & Basic Frontend

**Conceptual Server Tasks:**
- [ ] Set up headless Conceptual server:
  ```
  conceptual-server/
  ├── src/
  │   ├── main.ts
  │   ├── routes/
  │   │   ├── catalog.ts     # GET /catalog
  │   │   ├── specs.ts       # GET /specs  
  │   │   ├── spec.ts        # GET /spec/:name
  │   │   └── pull.ts        # POST /pull/:name
  │   └── services/
  │       └── synthesizer.ts
  └── library/               # All verified concepts
      ├── Liking/
      ├── Following/
      ├── Commenting/
      └── ...
  ```
- [ ] Implement GET /specs (concatenated specs for DSPy context)
- [ ] Implement POST /pull/:name (returns concept folder contents)

**Basic Frontend Tasks:**
- [ ] Create Vue app with minimal UI:
  ```
  frontend/
  ├── src/
  │   ├── App.vue
  │   ├── views/
  │   │   ├── CreateProject.vue
  │   │   └── ProjectStatus.vue
  │   ├── components/
  │   │   ├── AppDescriptionInput.vue
  │   │   └── ClarificationDialog.vue
  │   └── services/
  │       └── api.ts
  ```
- [ ] Implement CreateProject view:
  - Text input for app description
  - Submit button → POST /projects
  - Handle response: if `status: "awaiting_input"`, show ClarificationDialog
  - On clarification submit → POST /projects/:id/clarify
  - Poll for status updates or redirect to ProjectStatus view

---

### Week 1 Checklist

```
Backend Infrastructure:
[ ] ConceptualAI repo initialized with concept structure
[ ] Requesting, Authenticating, Sessioning working
[ ] MongoDB connected
[ ] Basic server starts

ProjectLedger:
[ ] Concept implemented
[ ] Tests written and passing
[ ] Queries return correct data

Planning:
[ ] DSPy Python agent running
[ ] PlanningConcept calls agent correctly
[ ] Clarification flow works
[ ] Tests written and passing

Syncs:
[ ] CreateProject sync fires on POST /projects
[ ] PlanningNeedsClarification responds with questions
[ ] PlanningComplete triggers next phase
[ ] UserClarifies resumes planning

Conceptual Server:
[ ] GET /specs returns all library specs
[ ] POST /pull/:name returns concept files

Frontend:
[ ] Create project form
[ ] Clarification dialog appears when needed
[ ] Basic status display
```

---

## Week 2: ConceptDesigning & Library Expansion

**Hours Budget:** 60 hours combined  
**Theme:** Design phase that selects and specs all concepts

### Goals
- [ ] Expand concept library to 10-12 verified concepts
- [ ] ConceptDesigning concept with DSPy agent
- [ ] Support duplicate library concepts with renaming
- [ ] Full flow: Plan → Design → (ready for implementation)

### Days 1-2: Expand Concept Library

**Priority Concepts to Add:**

| Concept | Purpose |
|---------|---------|
| Following | Social graph (user follows user) |
| Commenting | Comments on items |
| Profiling | Public user profiles |
| Tagging | Labels/categories on items |
| Posting | Generic content creation |

**Tasks:**
- [ ] For each concept:
  - Write spec markdown
  - Implement TypeScript class
  - Write comprehensive test file
  - Add to Conceptual library server

---

### Days 3-5: ConceptDesigning Concept

**Spec: ConceptDesigning**
```markdown
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

**queries**
`_getDesign(project: projectID) : (design: Design)`
```

**Tasks:**
- [ ] Create DSPy ConceptDesigningSignature:
  ```python
  class ConceptDesigningSignature(dspy.Signature):
      """Select library concepts and create specs for custom concepts."""
      
      plan: dict = dspy.InputField(desc="The app plan from planning phase")
      available_concepts: str = dspy.InputField(desc="All library concept specs")
      
      library_pulls: list[dict] = dspy.OutputField(
          desc="Library concepts to use. Each has libraryName (name in library), instanceName (name in project, can differ for duplicates), and bindings (generic param mappings)"
      )
      custom_concepts: list[dict] = dspy.OutputField(
          desc="Custom concepts to create. Each has name and full spec markdown"
      )
  ```
- [ ] Include examples in prompt showing duplicate handling:
  ```
  Example: App needs liking for both posts and comments
  
  library_pulls: [
    { libraryName: "Liking", instanceName: "PostLiking", bindings: { Item: "Post", User: "User" } },
    { libraryName: "Liking", instanceName: "CommentLiking", bindings: { Item: "Comment", User: "User" } }
  ]
  ```
- [ ] Implement ConceptDesigningConcept.ts
- [ ] Write ConceptDesigning.test.ts
- [ ] Add sync to wire into pipeline:
  ```typescript
  {
    name: "DesignComplete",
    when: {
      "ConceptDesigning.design": { project: "?projectId", design: "?design" }
    },
    then: [
      ["ProjectLedger.updateStatus", { project: "?projectId", status: "implementing" }],
      ["Implementing.implementAll", { project: "?projectId", design: "?design" }]
    ]
  }
  ```

---

### Days 6-7: Integration Testing & Frontend Updates

**Tasks:**
- [ ] Test full pipeline: Description → Plan → (Clarify?) → Design
- [ ] Verify duplicate concept handling works:
  - Test: "app with recipe liking and comment liking"
  - Verify: Two Liking entries with different instanceNames
- [ ] Verify custom spec generation:
  - Test: "todo app with tasks"
  - Verify: Task concept spec is valid and complete
- [ ] Update frontend to show design progress
- [ ] Add error handling for invalid designs

---

### Week 2 Checklist

```
Concept Library:
[ ] Following concept added and tested
[ ] Commenting concept added and tested
[ ] Profiling concept added and tested
[ ] Tagging concept added and tested
[ ] Posting concept added and tested
[ ] All concepts in library server

ConceptDesigning:
[ ] DSPy agent working
[ ] Correctly identifies library concepts
[ ] Handles duplicate concepts with renaming
[ ] Generates valid custom specs
[ ] Bindings correctly map generic params
[ ] Tests written and passing

Pipeline:
[ ] Plan → Design flow works end-to-end
[ ] Design output has correct structure

Frontend:
[ ] Shows design phase progress
[ ] Displays selected concepts
```

---

## Week 3: Implementation & Testing Loop

**Hours Budget:** 60 hours combined  
**Theme:** Generate working code with automated test-driven fix loops

### Goals
- [ ] Implementing concept generates code + comprehensive tests
- [ ] Iteration loop: generate → run tests → fix → repeat
- [ ] Library concepts pulled and renamed correctly
- [ ] All generated concepts compile and pass tests

### Days 1-3: Implementing Concept

**Spec: Implementing**
```markdown
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

**queries**
`_getImplementations(project: projectID) : (implementations: Object)`
```

**Tasks:**
- [ ] Create DSPy signatures:
  ```python
  class ImplementationSignature(dspy.Signature):
      """Generate TypeScript implementation for a concept spec."""
      
      spec_markdown: str = dspy.InputField()
      example_implementation: str = dspy.InputField(desc="Reference implementation to follow patterns")
      concept_name: str = dspy.InputField()
      
      typescript_code: str = dspy.OutputField()
  
  class TestGenerationSignature(dspy.Signature):
      """Generate comprehensive tests for a concept. Tests must cover all actions and queries."""
      
      spec_markdown: str = dspy.InputField()
      implementation: str = dspy.InputField()
      concept_name: str = dspy.InputField()
      example_tests: str = dspy.InputField(desc="Reference test file to follow patterns")
      
      test_code: str = dspy.OutputField(desc="Complete Deno test file with full coverage")
  
  class FixSignature(dspy.Signature):
      """Fix implementation based on test failures."""
      
      spec_markdown: str = dspy.InputField()
      current_implementation: str = dspy.InputField()
      test_code: str = dspy.InputField()
      test_errors: str = dspy.InputField()
      
      fixed_implementation: str = dspy.OutputField()
      explanation: str = dspy.OutputField()
  ```
- [ ] Implement library concept pulling with renaming:
  ```typescript
  async pullLibraryConcept(libraryName: string, instanceName: string, bindings: Record<string, string>) {
    // Fetch from Conceptual server
    const files = await fetch(`http://localhost:3001/pull/${libraryName}`).then(r => r.json());
    
    // Rename files and update class name
    const code = files.code
      .replace(`class ${libraryName}Concept`, `class ${instanceName}Concept`)
      .replace(`const PREFIX = "${libraryName}"`, `const PREFIX = "${instanceName}"`);
    
    // Update type aliases based on bindings
    // e.g., if bindings = { Item: "Post" }, replace "export type Item = ID" appropriately
    
    return { code, tests: files.tests, spec: files.spec };
  }
  ```
- [ ] Implement iteration loop:
  ```typescript
  async implementCustomConcept(conceptName: string, spec: string): Promise<Implementation> {
    const maxIterations = 3;
    
    let code = await this.callDSPy("implement", { spec, conceptName });
    let tests = await this.callDSPy("generateTests", { spec, code, conceptName });
    
    for (let i = 0; i < maxIterations; i++) {
      const testResult = await this.runTests(code, tests, conceptName);
      
      if (testResult.success) {
        return { code, tests, spec, status: "complete", iterations: i + 1 };
      }
      
      code = await this.callDSPy("fix", { spec, code, tests, errors: testResult.errors });
    }
    
    return { code, tests, spec, status: "error", iterations: maxIterations };
  }
  ```
- [ ] Write Implementing.test.ts

---

### Days 4-5: Test Infrastructure

**Tasks:**
- [ ] Create test runner service:
  ```typescript
  async function runConceptTests(
    conceptName: string,
    code: string,
    tests: string
  ): Promise<{ success: boolean; errors?: string }> {
    const tempDir = await Deno.makeTempDir();
    
    // Write concept file
    await Deno.writeTextFile(`${tempDir}/${conceptName}Concept.ts`, code);
    
    // Write test file
    await Deno.writeTextFile(`${tempDir}/${conceptName}.test.ts`, tests);
    
    // Write minimal utils/types.ts and other deps
    await this.writeTestDependencies(tempDir);
    
    // Run deno test
    const process = new Deno.Command("deno", {
      args: ["test", "--allow-all", `${tempDir}/${conceptName}.test.ts`],
      stdout: "piped",
      stderr: "piped"
    });
    
    const { success, stderr } = await process.output();
    
    return {
      success,
      errors: success ? undefined : new TextDecoder().decode(stderr)
    };
  }
  ```
- [ ] Create test dependency templates (MongoDB mock or real connection)
- [ ] Test the iteration loop with intentionally broken implementations
- [ ] Verify fix agent can resolve common errors

---

### Days 6-7: Pipeline Integration

**Tasks:**
- [ ] Add syncs for implementation phase:
  ```typescript
  {
    name: "ImplementationComplete",
    when: {
      "Implementing.implementAll": { project: "?projectId", implementations: "?implementations" }
    },
    then: [
      ["ProjectLedger.updateStatus", { project: "?projectId", status: "syncing" }],
      ["SyncGenerating.generate", { project: "?projectId", implementations: "?implementations" }]
    ]
  }
  ```
- [ ] Test full pipeline through implementation phase
- [ ] Measure success rates:
  - What % of library concepts rename correctly?
  - What % of custom concepts pass tests within 3 iterations?
- [ ] Tune prompts based on failure patterns

---

### Week 3 Checklist

```
Implementing Concept:
[ ] DSPy implementation agent generates valid TypeScript
[ ] DSPy test generation creates comprehensive tests
[ ] Fix agent corrects common errors
[ ] Iteration loop terminates correctly
[ ] Tests written and passing

Library Pulling:
[ ] Fetches concepts from Conceptual server
[ ] Renames class and PREFIX correctly
[ ] Handles duplicate concepts (different instanceNames)

Test Infrastructure:
[ ] Test runner executes Deno tests
[ ] Errors captured and parsed correctly
[ ] Dependencies available in test environment

Pipeline:
[ ] Implementation phase integrates with previous phases
[ ] Status updated correctly

Quality:
[ ] >90% of concepts generate working implementations
[ ] Average <2 iterations needed
```

---

## Week 4: Sync Generation, Assembly & Polish

**Hours Budget:** 60 hours combined  
**Theme:** Complete the pipeline and deliver a polished product

### Goals
- [ ] SyncGenerating concept creates valid synchronizations
- [ ] Assembling concept packages complete project
- [ ] OpenAPI spec generated
- [ ] Frontend complete with full flow
- [ ] Demo: generate 3 working apps

### Days 1-2: SyncGenerating Concept

**Spec: SyncGenerating**
```markdown
### Concept: SyncGenerating [Project]

**purpose**
Generate synchronizations that wire concepts together for the application.

**principle**
Syncs orchestrate concept interactions; passthrough routes expose direct concept access.

**state (SSF)**
a set of SyncJobs with
  a project ID
  a syncs Array<SyncDefinition>
  a passthroughInclusions Object
  a passthroughExclusions Array<String>
  a status String

**actions**

* **generate (project: projectID, plan: Object, implementations: Object) : (project: projectID, syncs: Array, passthrough: Object)**
  effects: analyzes plan and implementations, generates sync definitions

**queries**
`_getSyncs(project: projectID) : (syncs: Object)`
```

**Tasks:**
- [ ] Create DSPy SyncGenerationSignature:
  ```python
  class SyncGenerationSignature(dspy.Signature):
      """Generate synchronizations for an application."""
      
      plan: dict = dspy.InputField()
      concept_specs: str = dspy.InputField(desc="All concept specs (library + custom)")
      concept_names: list[str] = dspy.InputField(desc="All concept instance names")
      
      syncs: list[dict] = dspy.OutputField()
      passthrough_inclusions: dict = dspy.OutputField()
      passthrough_exclusions: list[str] = dspy.OutputField()
  ```
- [ ] Build sync pattern library in prompt:
  - Auth-protected action pattern
  - Multi-concept cascade pattern
  - Aggregation/feed pattern
- [ ] Implement SyncGeneratingConcept.ts
- [ ] Write SyncGenerating.test.ts
- [ ] Validate generated syncs (check concept/action names exist)

---

### Days 3-4: Assembling Concept

**Spec: Assembling**
```markdown
### Concept: Assembling [Project]

**purpose**
Package all generated code into a downloadable, runnable project.

**principle**
Assembly creates a complete project structure with all dependencies configured.

**state (SSF)**
a set of Assemblies with
  a project ID
  a projectPath String
  a downloadUrl String
  a status String

**actions**

* **assemble (project: projectID) : (project: projectID, downloadUrl: String)**
  effects: creates project structure, writes all files, generates OpenAPI, zips

**queries**
`_getDownloadUrl(project: projectID) : (downloadUrl: String)`
```

**Tasks:**
- [ ] Implement AssemblingConcept.ts:
  ```typescript
  async assemble({ project }: { project: Project }) {
    const projectPath = `./output/${project}`;
    
    // Gather all artifacts
    const plan = await this.concepts.Planning._getPlan({ project });
    const design = await this.concepts.ConceptDesigning._getDesign({ project });
    const implementations = await this.concepts.Implementing._getImplementations({ project });
    const syncs = await this.concepts.SyncGenerating._getSyncs({ project });
    
    // Create project structure
    await this.createStructure(projectPath);
    
    // Write all concept files
    for (const [name, impl] of Object.entries(implementations)) {
      await Deno.mkdir(`${projectPath}/src/concepts/${name}`, { recursive: true });
      await Deno.writeTextFile(`${projectPath}/src/concepts/${name}/${name}Concept.ts`, impl.code);
      await Deno.writeTextFile(`${projectPath}/src/concepts/${name}/${name}.test.ts`, impl.tests);
      await Deno.writeTextFile(`${projectPath}/src/concepts/${name}/${name}.md`, impl.spec);
    }
    
    // Write Requesting concept (always included)
    await this.copyRequestingConcept(projectPath, syncs.passthrough);
    
    // Write concepts/index.ts
    await this.writeConceptsIndex(projectPath, Object.keys(implementations));
    
    // Write syncs
    await Deno.writeTextFile(`${projectPath}/src/syncs/index.ts`, this.formatSyncs(syncs.syncs));
    
    // Generate OpenAPI
    const openapi = this.generateOpenAPI(plan, syncs);
    await Deno.writeTextFile(`${projectPath}/openapi.yaml`, openapi);
    
    // Write boilerplate
    await this.writeBoilerplate(projectPath, plan);
    
    // Zip
    const zipPath = await this.zipProject(projectPath);
    
    return { project, downloadUrl: `/downloads/${project}.zip` };
  }
  ```
- [ ] Implement OpenAPI generation
- [ ] Add download route
- [ ] Write Assembling.test.ts

---

### Days 5-6: Frontend Polish & Full Flow

**Tasks:**
- [ ] Complete frontend UI:
  - Project creation with description input
  - Clarification Q&A dialog
  - Status display for each phase
  - Download button when complete
  - Project history (list user's projects)
- [ ] Add polling for project status (or use long-polling)
- [ ] Add error handling and display
- [ ] Style and polish UI

---

### Day 7: Demo & Documentation

**Tasks:**
- [ ] Generate and run demo apps:
  1. **Todo App** - Pure CRUD
     - Create, complete, delete tasks
     - Test all endpoints
  2. **Blog with Comments** - CRUD + Social
     - Posts, comments, likes
     - Auth-protected writes
  3. **Recipe Sharing App** - Full social with duplicates
     - Recipes, comments
     - RecipeLiking + CommentLiking (duplicate Liking concept)
     - User follows
- [ ] Run each generated app and verify endpoints work
- [ ] Write documentation:
  - README with setup instructions
  - Architecture overview
  - How to use guide
- [ ] Record demo video
- [ ] Fix any remaining issues

---

### Week 4 Checklist

```
SyncGenerating:
[ ] Generates valid sync definitions
[ ] Handles auth patterns
[ ] Handles multi-concept operations
[ ] Passthrough configuration correct
[ ] Tests written and passing

Assembling:
[ ] Creates correct project structure
[ ] All files written correctly
[ ] OpenAPI spec generated
[ ] Zip download works
[ ] Tests written and passing

Frontend:
[ ] Full flow works end-to-end
[ ] Clarification dialog functional
[ ] Status display accurate
[ ] Download works
[ ] Project history visible

Demo Apps:
[ ] Todo app generates and runs
[ ] Blog app generates and runs
[ ] Recipe app (with duplicate concepts) generates and runs
[ ] <5 minutes generation time

Documentation:
[ ] README complete
[ ] Setup instructions clear
[ ] Demo video recorded
```

---

## Appendix A: Concept Spec Format Reference

```markdown
### Concept: ConceptName [GenericParam1, GenericParam2]

**purpose**
One sentence describing what this concept enables.

**principle**
Core invariant or behavioral rule.

**state (SSF)**
\`\`\`
a set of Things with
  a thing ID
  a property Type
  an optional property Type
  a set of SubThings with
    a subproperty Type
\`\`\`

**actions**

* **actionName (param1: Type, param2: Type) : (result: Type)**
  requires: precondition
  effects: what changes

**queries**
\`_queryName(param: Type) : (result: Type)\`
```

---

## Appendix B: Implementation Pattern Reference

```typescript
import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";

export type GenericParam = ID;

const PREFIX = "ConceptName" + ".";

interface XState {
  _id: ID;
  property: Type;
  subThings: Array<{ subproperty: Type }>;
}

export default class ConceptNameConcept {
  xs: Collection<XState>;

  constructor(private readonly db: Db) {
    this.xs = this.db.collection<XState>(PREFIX + "xs");
  }

  async actionName({ param1, param2 }: { param1: Type; param2: Type }): Promise<{ ok: boolean } | { error: string }> {
    return { ok: true };
  }

  async _queryName({ param }: { param: Type }): Promise<Array<{ result: Type }>> {
    return [{ result: value }];
  }
}
```

---

## Appendix C: Sync Definition Format

```typescript
interface SyncDefinition {
  name: string;
  when: {
    [actionPattern: string]: Record<string, string>;
  };
  where?: (bindings: Record<string, any>, concepts: Concepts) => Promise<Record<string, any> | null>;
  then: Array<[string, Record<string, string>]>;
}
```

---

## Appendix D: Daily Standup Template

```markdown
## Date: YYYY-MM-DD

### Yesterday
- [What was completed]

### Today  
- [What will be worked on]

### Blockers
- [Any blockers]

### Hours Logged
- Davis: X hours
- Anthony: X hours
```

---

## Appendix E: Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| LLM generates invalid code | High | Medium | **Test-driven iteration loop**: generate tests from spec, run tests, fix until pass |
| Sync generation too complex | Medium | High | Start with simple patterns, expand gradually |
| Gemini rate limits | Medium | Medium | Use Flash for iteration loops, Pro for planning/design |
| Duplicate concept renaming breaks | Medium | Medium | Thorough testing of rename logic |
| Clarification loops infinitely | Low | Medium | Max clarification rounds (3), timeout |

---

## Success Metrics

By end of Week 4:

1. **Concept Generation Success Rate:** >90% of specs generate working implementations within 3 iterations (verified by tests)

2. **End-to-End Success Rate:** >80% of well-formed app descriptions result in working, runnable backends

3. **Generation Time:** <5 minutes from description to downloadable project

4. **Interactive Planning:** Clarification flow works when needed

5. **Duplicate Handling:** Apps with multiple instances of same concept (e.g., PostLiking + CommentLiking) work correctly

6. **App Coverage:** Successfully generates:
   - CRUD apps (todo, notes, inventory)
   - Social apps (likes, comments, follows)
   - Combined (blog, recipe sharing, micro-social)

7. **Code Quality:** Generated code:
   - Compiles without errors
   - Passes comprehensive generated tests
   - Follows established patterns
   - Includes valid OpenAPI spec
