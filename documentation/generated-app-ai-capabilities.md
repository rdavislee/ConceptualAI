# AI Capabilities in Generated Apps

This guide explains what AI-backed behavior in generated apps usually looks like and how to configure it safely.

Back to docs home: [ConceptualAI User Documentation](./README.md)

## What AI-backed generated apps can do

Generated apps may include AI-backed features such as:

- Conversation or chat experiences
- Document-aware answering or assistants
- Classification or moderation
- Structured extraction
- Planning, coaching, or schedule assistance

Not every generated app includes AI. It depends on what your app prompt and plan require.

## How AI works in generated backends

In generated backends, AI calls are handled through the shared helper in `src/utils/ai.ts`.

That means:

- Provider and model are configured with environment variables
- The backend code calls the helper instead of talking directly to provider SDKs in random places
- Structured AI output can be schema-validated when the app expects JSON

## Backend AI environment variables

If your generated app uses AI-backed features, check the backend `.env.template`.

The most important values are:

- `AI_PROVIDER`
- `AI_MODEL`
- The matching provider key such as `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `XAI_API_KEY`

Common example:

```env
AI_PROVIDER=gemini
AI_MODEL=gemini-flash-latest
GEMINI_API_KEY=your-key-here
```

## How to use AI features well

When testing a generated app with AI:

- Use realistic but small inputs first
- Check that the AI feature has enough source context to do its job
- Verify structure and usefulness, not just whether the wording looks nice
- Review outputs before using them in real-world workflows

For example:

- In a coaching app, verify the result covers the requested time horizon and constraints
- In an extraction app, verify required fields are present and parseable
- In a document-aware app, verify the answer is actually grounded in the uploaded material

## Important limits

AI output is probabilistic.

That means:

- Outputs can vary between runs
- Responses can still be wrong or incomplete
- Good prompts and good source context matter a lot
- You should validate important outputs before relying on them

## Cost and keys

If your app uses a provider API key, usage on that key may create provider-side charges.

Before running an AI-heavy app:

- Check the provider pricing page
- Set usage alerts or budget limits in the provider dashboard
- Use smaller models during experimentation if appropriate

## Deployment note

When deploying a generated app, make sure the backend host has the same AI env vars set that worked locally.

Use: [Deploy Your Generated App with Railway](./deploy-with-railway.md)
