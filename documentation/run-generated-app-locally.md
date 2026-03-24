# Run Your Generated App Locally

Use this after generation to verify everything works before deployment.

Back to beginner guide: [Beginner App-Building Guide](./getting-started-beginner.md)

## 1) Prepare environment files

In generated backend:

- Rename `.env.template` to `.env`
- Set `MONGODB_URL`, `DB_NAME`, `JWT_SECRET`
- If the app uses AI-backed features, also set `AI_PROVIDER`, `AI_MODEL`, and the matching provider API key such as `GEMINI_API_KEY`

Why these matter:

- `MONGODB_URL`: points your backend to your MongoDB server.
- `DB_NAME`: selects the database to read/write.
- `JWT_SECRET`: secures and validates login tokens.
- `AI_PROVIDER` and `AI_MODEL`: choose which model backend AI features use.
- Provider API key such as `GEMINI_API_KEY`: authorizes AI calls for features that rely on `src/utils/ai.ts`.

In generated frontend:

- Rename `.env.template` to `.env`
- For local runs, frontend values are usually already set correctly.
- Only change frontend `.env` values for non-local runs (for example, deployment domains/API URLs).

Help links:

- [Get a MongoDB Atlas Connection URL (Free Tier)](./get-mongodb-atlas-url.md)
- [Get a Gemini API Key](./get-gemini-api-key.md)

## 2) Install dependencies

From each generated project folder (backend and frontend), install dependencies using the package manager listed in that project.

## 3) If the app uses AI features

Before starting the app, make sure the backend `.env` includes:

- `AI_PROVIDER`
- `AI_MODEL`
- The matching provider API key such as `GEMINI_API_KEY`

Then test the AI feature with a few representative inputs and confirm the output covers the intended scope, not just that it returns something.

Use: [AI Capabilities in Generated Apps](./generated-app-ai-capabilities.md)

## 4) Start backend, then frontend

Run backend first so frontend can connect.

Then run frontend and open the local URL shown in terminal.

## 5) Basic test checklist

- Can a new user register?
- Can the user log in?
- Do core pages load without errors?
- Do create/edit/delete actions work for your key feature?
- Do errors show clearly when something fails?
- If the app uses AI, do AI-backed responses have the right structure, scope, and usefulness?

## 6) If something breaks

Use: [Troubleshooting](./troubleshooting.md)

## 7) Ready to publish?

Use: [Deploy Your Generated App with Railway](./deploy-with-railway.md)
