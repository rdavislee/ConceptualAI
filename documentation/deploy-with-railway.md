# Deploy Your Generated App with Railway

This guide helps you deploy backend + frontend so anyone can use your app online.

Back to docs home: [ConceptualAI User Documentation](./README.md)

## Why Railway?

- Simple Git-based deploy flow
- Good for full-stack projects and monorepos
- Easy environment variable management

Official docs:

- Monorepo deploy guide: https://docs.railway.com/guides/deploying-a-monorepo
- React deploy guide: https://docs.railway.app/guides/react

## Recommended deployment model

Create one Railway project with two services:

- `backend` service (API server)
- `frontend` service (web app)

## Step-by-step

1. Push your generated backend/frontend code to GitHub.
2. Create a Railway project and connect the repository.
3. Create the backend service and set its root directory to backend folder.
4. Create the frontend service and set its root directory to frontend folder.
5. Configure backend environment variables (`MONGODB_URL`, `DB_NAME`, `JWT_SECRET`, plus any other required vars).
6. Configure frontend environment variables (API base URL and any frontend template vars).
7. Deploy both services.
8. Generate public domains for both services.
9. Update frontend API URL env var to point to backend public domain.
10. Redeploy frontend after API URL update.

## AI-backed apps

If the generated backend includes AI-backed features, also set:

- `AI_PROVIDER`
- `AI_MODEL`
- The matching provider key such as `GEMINI_API_KEY`

If these are missing in Railway, AI-backed routes may fail even if the rest of the app works.

Use: [AI Capabilities in Generated Apps](./generated-app-ai-capabilities.md)

## Pre-deploy checklist

- Local app works first ([Run Your Generated App Locally](./run-generated-app-locally.md))
- No secrets in git
- Production domains set in CORS-related backend env vars (if applicable)

## Common mistakes

- Deploying frontend before backend URL is known
- Forgetting to set production env vars in Railway
- Forgetting to redeploy frontend after env var changes

## After deploy

Test from an incognito window:

- Register/login
- Core flow for your main feature
- Error handling (invalid input, missing data)

If anything fails, use: [Troubleshooting](./troubleshooting.md)
