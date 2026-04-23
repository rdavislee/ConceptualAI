# ConceptualAI

A concise repository for the ConceptualAI project by Davis Lee and Anthony Meng.

## License

**ConceptualAI (this repository, excluding third-party trees listed below)** is released under the [MIT License](LICENSE).

### Dyad (vendored)

This project includes [Dyad](https://github.com/dyad-sh/dyad) under `src/concepts/FrontendGenerating/dyad/`. Dyad's own terms are in [`src/concepts/FrontendGenerating/dyad/LICENSE`](src/concepts/FrontendGenerating/dyad/LICENSE):

- **Code outside `src/pro/`** in upstream Dyad is under **Apache License 2.0** (full text in that file; copyright **Dyad Tech, Inc.**).
- **Code under `src/pro/`** in upstream Dyad is under a **separate fair-source license** ([FSL 1.1–Apache 2.0](https://fsl.software/)); that directory is **not** present in this vendored copy, so the fair-source portion does not apply unless you add it yourself.

**What you should do:** Keep the existing [`dyad/LICENSE`](src/concepts/FrontendGenerating/dyad/LICENSE) (and any license/copyright headers in those files) when you distribute or fork this repo. That satisfies Apache 2.0's requirement to pass along the license for the Dyad portions. If you **modify** files under `dyad/`, Apache 2.0 also expects **prominent notices** that those files were changed (see section 4(b) of the Apache license in that file).

Dyad's `package.json` may list `"license": "MIT"`; for compliance, treat the **`LICENSE` file in the dyad tree** as the source of truth for vendored Dyad code.

## Quick Start

1. Set up environment variables:

   Copy the template file and fill in your values:

   ```bash
   cp .env.template .env
   ```

   Then edit `.env` and set:
   - `MONGODB_URL`: Your MongoDB connection string (e.g., `mongodb://localhost:27017` or MongoDB Atlas connection string)
   - `DB_NAME`: The name of the database to use (e.g., `conceptualai`)
   - `GEMINI_TIER`: Server-side default metadata for local development (`1`, `2`, or `3`; `0` is unsupported)
   - `SUPABASE_URL`: Your Supabase project URL (e.g., `https://your-project.supabase.co`)
   - `SUPABASE_SECRET_KEY`: Your Supabase secret key (for server-side storage operations)
   - `SUPABASE_STORAGE_BUCKET`: The name of the storage bucket to use for concepts (defaults to `concepts` if not set)

2. Generate imports (required before running server or tests):

   ```bash
   deno task import
   ```

3. Start the server:

   ```bash
   deno task start
   ```

## Setup

### Environment Variables

The application requires the following environment variables to be set in a `.env` file:

- `MONGODB_URL`: MongoDB connection string (e.g., `mongodb://localhost:27017` or MongoDB Atlas connection string)
- `DB_NAME`: Name of the database to use (e.g., `conceptualai`)
- `GEMINI_TIER`: Server-side default metadata for local development (`1`, `2`, or `3`; `0` is unsupported)
- `SUPABASE_URL`: Your Supabase project URL (e.g., `https://your-project.supabase.co`)
- `SUPABASE_SECRET_KEY`: Your Supabase secret key (for server-side storage operations)
- `SUPABASE_STORAGE_BUCKET`: (Optional) The name of the storage bucket to use for concepts (defaults to `concepts` if not set)
- `PREVIEWS_ENABLED`: Enable hosted build previews (`true`/`false`)
- `PREVIEW_PROVIDER`: Preview provider (`freestyle` default, `deno`, or `mock` for tests)
- `DENO_DEPLOY_TOKEN`: Server-managed token used to create preview deployments
- `PREVIEW_TTL_MINUTES`: Preview lifetime (default `15`)
- `PREVIEW_MONGODB_URL`: Mongo URL for managed preview databases (defaults to `MONGODB_URL` if unset)
- `PREVIEW_DB_PREFIX`: Prefix for managed preview database names
- `PREVIEW_MAX_ACTIVE_PER_USER`: Per-owner active preview cap (default `1`)

### BYOK Headers for Pipeline Endpoints

Pipeline-triggering endpoints require user-provided Gemini credentials via headers:

- `X-Gemini-Api-Key`
- `X-Gemini-Tier` (`1`, `2`, or `3`; tier `0` is rejected)

The backend validates key+tier before starting sandboxed generation and does not fall back to a server-side Gemini key.

Copy `.env.template` to `.env` and fill in your values:

```bash
cp .env.template .env
```

The `.env` file is automatically loaded by the application using Deno's dotenv support.

### Generate Imports

Before running the server or tests, generate the required imports. This task scans the `src/concepts/` directory and generates the necessary import files (`concepts.ts` and `test_concepts.ts`) that register all concept classes:

```bash
deno task import
```

Or use the build task (which is an alias for import):

```bash
deno task build
```

**Note:** You must run this command whenever you add, remove, or rename concept files.

## Running the Server

**Important:** Make sure you've run `deno task import` first (see Setup section above).

### Main Application Server

Start the main application server (with concepts and synchronizations). This runs the full ConceptualAI application with all concepts and sync operations:

```bash
deno task start
```

This command starts the server with all necessary permissions for network access, file I/O, system operations, and environment variable access.

### Concept Server

**Note:** The import step is also required before running the concept server.

Start the concept API server (runs on port 8000 by default):

```bash
deno task concepts
```

You can customize the port and base URL:

```bash
deno task concepts -- --port 3000 --baseUrl /api
```

## Running Tests

Run all tests using Deno's test runner:

```bash
deno test --allow-net --allow-read --allow-write --allow-sys --allow-env
```

To run tests for a specific concept:

```bash
deno test --allow-net --allow-read --allow-write --allow-sys --allow-env src/concepts/LikertSurvey/LikertSurveyConcept.test.ts
```

To run engine tests:

```bash
deno test --allow-net --allow-read --allow-write --allow-sys --allow-env src/engine/test/run.ts
```

## Conceptual CLI

The Conceptual CLI (`conceptual`) is a command-line tool for interacting with the ConceptualAI registry. It allows you to manage concepts locally and publish them to the hub.

### Compile Conceptual CLI

To create a convenient binary, run the following command from the root of the directory:

```bash
deno compile -A --output conceptual .conceptual/conceptual.ts
```

This creates a standalone executable named `conceptual` that can be run directly without Deno installed.

### CLI Commands

#### `./conceptual init`

Initializes a new conceptual project in the current workspace. Sets up the workspace structure for concept development.

#### `./conceptual list`

Lists all concepts found in the local workspace. Scans `design/concepts/` and `src/concepts/` directories and categorizes concepts as complete (all three required files present) or incomplete (missing files).

#### `./conceptual login`

Authenticates with the ConceptualAI registry. Prompts for email and password, then stores authentication tokens locally for use in subsequent commands. Required before publishing concepts.

#### `./conceptual install {USERNAME}/{CONCEPT_NAME}@{VERSION}`

Installs a concept from the hub to the local workspace. Downloads the specification, implementation, and test files and places them in the correct workspace locations. Version is optional (defaults to latest).

**Example:**
```bash
conceptual install johndoe/MyConcept@1
```

#### `./conceptual publish {CONCEPT_NAME}`

Publishes a concept from the local workspace to the hub. Validates that all three required files exist, then uploads them. Requires authentication (run `conceptual login` first). Automatically creates version 1 for new concepts or increments the version for existing concepts.

**Example:**
```bash
conceptual publish MyConcept
```
