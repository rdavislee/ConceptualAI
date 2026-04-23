# ConceptualAI

ConceptualAI is a Deno-based backend for concept-driven app generation by Davis Lee and Anthony Meng.

## Related Repositories

- **Frontend:** [github.com/ameng10/ConceptualAIFrontend](https://github.com/ameng10/ConceptualAIFrontend)
- **Headless server:** [github.com/rdavislee/HeadlessConceptual](https://github.com/rdavislee/HeadlessConceptual)

## License

This repository is released under the [MIT License](LICENSE).

It also includes a vendored copy of Dyad under `src/concepts/FrontendGenerating/dyad/`; keep that subtree's own license file with any redistribution: [`src/concepts/FrontendGenerating/dyad/LICENSE`](src/concepts/FrontendGenerating/dyad/LICENSE).

## Documentation

For the actual user and architecture guides, start in [`documentation/README.md`](documentation/README.md).

## Setup Overview

For a full local setup, you usually run three pieces together:

1. the **HeadlessConceptual** library server
2. this **ConceptualAI** backend
3. the **ConceptualAIFrontend** app

This repo also contains a `library/` directory with source concepts, but they are not automatically available from the headless library server.

## Prerequisites

- [Deno](https://deno.com/)
- [Node.js and npm](https://nodejs.org/)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) if you want sandboxed generation or preview builds
- MongoDB, either local or Atlas
- At least one AI provider API key, usually Gemini for the current flow

## Full Local Setup

### 1. Set up the headless library server

Clone the headless server repo:

```bash
git clone https://github.com/rdavislee/HeadlessConceptual
cd HeadlessConceptual
```

Use the headless server's own API endpoints to add or register the library concepts you want it to serve. Do not assume this repo's local `library/` folder is automatically exposed by the headless server.

Create the headless server `.env` from its template and fill in the required values:

```bash
cp .env.template .env
```

At minimum, set:

- `MONGODB_URL`
- `DB_NAME`
- `JWT_SECRET`
- `CREDENTIAL_VAULT_ENCRYPTION_KEY`
- `GEMINI_API_KEY` and/or `GOOGLE_GENERATIVE_AI_API_KEY`

Optional but commonly needed in the headless server:

- `GITHUB_APP_CLIENT_ID`
- `GITHUB_APP_CLIENT_SECRET`
- `GITHUB_APP_CALLBACK_URL`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `XAI_API_KEY`

Then generate imports in that repo and start the headless server using its own README instructions:

```bash
deno task import
```

By default, that serves the concept API at:

```text
http://localhost:8000/api
```

Once concepts have been registered in the headless server, this repo reads them back from that server for design and implementation.

If you need the full headless app instead of only the concept library endpoint, run:

```bash
deno task start
```

### 2. Configure this repository

From this repository root, create `.env` from the template:

```bash
cp .env.template .env
```

Set the values you actually use. The most important ones are:

- `MONGODB_URL`
- `DB_NAME`
- `JWT_SECRET`
- `CREDENTIAL_VAULT_ENCRYPTION_KEY`
- `HEADLESS_URL=http://localhost:8000/api`
- `GEMINI_API_KEY` and/or `GOOGLE_GENERATIVE_AI_API_KEY`

Other supported AI keys:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `XAI_API_KEY`

`HEADLESS_URL` matters for concept-library-backed design and implementation. This repo reads library concepts from the headless server, so point it at a headless server instance that already has the needed concepts registered through its API.

If you plan to use sandboxed generation or preview infrastructure, also review:

- `MAX_CONCURRENT_SANDBOXES`
- `PREVIEWS_ENABLED`
- `PREVIEW_PROVIDER`
- `DENO_DEPLOY_TOKEN`
- `FREESTYLE_API_KEY`
- `PREVIEW_MONGODB_URL`
- `PREVIEW_DB_PREFIX`
- `PREVIEW_MAX_ACTIVE_PER_USER`

If you want Docker-backed sandboxing, make sure Docker is running and build the sandbox image:

```bash
deno task build
```

That task installs Dyad dependencies, regenerates imports, and builds the Docker image defined in `Dockerfile.sandbox`.

### 3. Run this backend

Generate imports before starting:

```bash
deno task import
```

Then start the main server:

```bash
deno task start
```

This backend uses the default server configuration from the repo and `.env`.

### 4. Run the frontend

Clone the frontend repo:

```bash
git clone https://github.com/ameng10/ConceptualAIFrontend
cd ConceptualAIFrontend
npm install
npm run dev
```

If the frontend needs a backend base URL in its own config or environment, point it at the ConceptualAI server you started in step 3.

## Daily Development Flow

In practice, local development usually looks like this:

1. start the headless server
2. start this repo with `deno task start`
3. start the frontend with `npm run dev`

Whenever you add, remove, or rename concepts in this repo, run:

```bash
deno task import
```

## Environment Notes

The root `.env.template` includes additional settings for:

- AI model selection
- preview deployment providers
- Docker-backed sandbox limits
- generated test timeouts

If you are just getting started, you usually only need MongoDB, secrets, `HEADLESS_URL`, and your AI provider keys.

