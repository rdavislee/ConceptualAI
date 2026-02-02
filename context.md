# Context

This file links to the critical components of the Conceptual AI project to provide full context for development agents.

## Documentation & Plans
- [Project Plan](./conceptual-ai-iap-plan.md)
- [Sandboxing Plan](./sandboxing-plan.md)
- [API Documentation](./API.md)
- [README](./README.md)

## Conceptual Architecture & Design
- [Architecture Overview](./design/background/architecture.md)
- [Concept Design Overview](./design/background/concept-design-overview.md)
- [Concept Specifications](./design/background/concept-specifications.md)
- [Implementing Concepts](./design/background/implementing-concepts.md)
- [Implementing Synchronizations](./design/background/implementing-synchronizations.md)

## Core Concepts
- [Requesting (API Server)](./src/concepts/Requesting/RequestingConcept.ts)
- [Project Ledger (Data)](./src/concepts/ProjectLedger/ProjectLedgerConcept.ts)
- [Planning (Agent)](./src/concepts/Planning/PlanningConcept.ts)
- [Concept Designing (Agent)](./src/concepts/ConceptDesigning/ConceptDesigningConcept.ts)
- [Authenticating](./src/concepts/Authenticating/AuthenticatingConcept.ts)
- [Sessioning](./src/concepts/Sessioning/SessioningConcept.ts)

## Synchronization Logic (Business Logic)
- [Sync Registry](./src/syncs/syncs.ts)
- [Authentication Syncs](./src/syncs/auth.sync.ts)
- [Query Syncs (GET Requests)](./src/syncs/queries.sync.ts)
- [Project Lifecycle Syncs](./src/syncs/projects.sync.ts)
- [Planning Syncs](./src/syncs/planning.sync.ts)
- [Designing Syncs](./src/syncs/designing.sync.ts)

## Engine
- [Sync Engine Core](./src/engine/mod.ts)
- [Sync Definitions](./src/engine/sync.ts)
- [Engine Types](./src/engine/types.ts)

## Entry Point
- [Main Application](./src/main.ts)
