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
