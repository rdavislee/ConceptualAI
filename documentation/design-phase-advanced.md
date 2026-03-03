# Design Phase (Advanced)

This page is for users who want deeper control.

If you are new, go back to: [Beginner App-Building Guide](./getting-started-beginner.md)

## What the design phase does

After planning, the design phase decides:

- Which reusable library concepts to pull
- Which custom concepts to generate
- How your feature set maps to concept boundaries

This phase affects implementation quality, generated API structure, and long-term maintainability.

### Library concepts vs. custom concepts

The system maintains a library of pre-built, tested concepts for common behaviors (authentication, posting, liking, tagging, and many others). During design, the system maps your app's features to these library concepts first and only generates custom concepts for behavior the library does not cover. Reusing library concepts is faster and more reliable than generating from scratch — see [Concepts and Syncs](./concepts-and-syncs.md#the-concept-library) for more on why.

## When should you review design output?

Review design output if:

- The app has tricky domain rules
- You need clear modular boundaries
- You want predictable API behavior
- You plan to iterate on the same project many times

## How to give useful design feedback

Use specific feedback, not generic requests.

Weak:

> "Make it better."

Strong:

> "Split notifications and messaging into separate concepts. Keep read-state in messaging only."

Other examples:

- "Use separate concepts for billing, invoicing, and subscription states."
- "Keep moderation logic separate from posting logic."
- "Add explicit profile onboarding before access to posting."

## Practical review checklist

- Do concept names match real business ideas?
- Are unrelated responsibilities mixed together?
- Are user permissions represented in a clear place?
- Are likely future features blocked by this structure?

## Relation to Concepts and Syncs

To understand why this structure matters, read:

- [Concepts and Syncs (Advanced)](./concepts-and-syncs.md)

## Next steps

- Need setup help: [Get a Gemini API Key](./get-gemini-api-key.md), [Get a MongoDB Atlas Connection URL (Free Tier)](./get-mongodb-atlas-url.md)
- Need run/deploy help: [Run Your Generated App Locally](./run-generated-app-locally.md), [Deploy Your Generated App with Railway](./deploy-with-railway.md)
