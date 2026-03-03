# Concepts and Syncs (Advanced)

This is an advanced explanation of the architecture style used by ConceptualAI.

If you want the quick practical path, use: [Beginner App-Building Guide](./getting-started-beginner.md)

## Concept (what it means)

A **concept** is a focused unit of behavior with its own state and actions.

Think of concepts like small specialists:

- One concept manages authentication
- Another manages posting
- Another manages profiles

Each concept stays responsible for one coherent area.

## Sync (what it means)

A **sync** is an event-based coordination rule.

It connects concepts without forcing them to become one giant class.

In simple terms:

- A user does something (request/event)
- A sync checks conditions
- The sync triggers actions across concepts
- The system returns a response

## Why this helps

- Better modularity (small parts instead of one giant service)
- Better legibility (easier to reason about behavior)
- Better reuse (concepts can be composed in different apps)

## The concept library

Because concepts are self-contained, many of them are not specific to any single application. Authentication, posting, liking, tagging, scheduling — these behaviors appear across countless apps with the same core logic.

ConceptualAI maintains a **library of pre-built concepts** that have already been implemented and tested. During the design phase, the system matches your app's needs against this library and pulls in any concept that fits. Only truly app-specific behavior needs to be generated from scratch.

This matters for several reasons:

- **Faster generation.** Reusing a proven concept skips implementation and testing for that piece entirely.
- **Higher quality.** Library concepts have been refined over many projects. They handle edge cases (like timing-safe password comparison, or pagination with multiple sort modes) that a one-off generation might miss.
- **Consistency.** Every app that uses the same library concept gets the same reliable interface, making it easier to reason about behavior across projects.
- **Composability.** Library concepts are designed to work together through syncs. Authenticating + Sessioning + Profiling compose cleanly because they were built with that pattern in mind.

When the design phase identifies a need that no library concept covers, it generates a custom concept instead. The generated app can mix library and custom concepts freely — they follow the same interface conventions.

## Daniel Jackson references

To understand the design philosophy in depth:

- **Software Abstractions** by Daniel Jackson (book):
  - https://mitpress.mit.edu/9780262528900/software-abstractions
- **The Essence of Software** perspective:
  - https://press.princeton.edu/ideas/daniel-jackson-on-the-essence-of-software
- **Concept + sync tutorial context**:
  - https://essenceofsoftware.com/tutorials/concept-basics/sync
- **Recent paper artifact listing (DSpace@MIT)**:
  - https://hdl.handle.net/1721.1/164199

## How this affects your generated app

If your generated app feels "off," it is often a concept boundary or sync logic issue.

Where to intervene:

- Early: update plan and design feedback
- Mid-pipeline: modify design to separate responsibilities
- Later: manually adjust generated code after export

## Related docs

- [Design Phase (Advanced)](./design-phase-advanced.md)
- [Troubleshooting](./troubleshooting.md)
- [Beginner App-Building Guide](./getting-started-beginner.md)
