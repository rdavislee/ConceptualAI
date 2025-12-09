# Conceptual CLI Specification

## Requirements

### Backend Workspace Structure

The backend workspace must be using concepts and syncs practices. The workspace should be designed as following:

- **Specification markdown files** in `design/concepts/{CONCEPT_NAME}/{CONCEPT_NAME}.md`
- **Implementation of concept** in `src/concepts/{CONCEPT_NAME}/{CONCEPT_NAME}Concept.ts`
- **Test file** in `src/concepts/{CONCEPT_NAME}/{CONCEPT_NAME}Concept.test.ts`

## Commands

### `conceptual init`

TODO: add description

### `conceptual list`

Lists all concepts found in the local workspace. The command scans the workspace to discover concepts and categorizes them based on completeness.

**Behavior:**

- Scans `design/concepts/` and `src/concepts/` directories to discover concepts
- For each concept found, checks if all three required files exist:
  - Specification: `design/concepts/{CONCEPT_NAME}/{CONCEPT_NAME}.md`
  - Implementation: `src/concepts/{CONCEPT_NAME}/{CONCEPT_NAME}Concept.ts`
  - Test: `src/concepts/{CONCEPT_NAME}/{CONCEPT_NAME}Concept.test.ts`
- A concept is **complete** if all three files are present
- A concept is **incomplete** if any of the three files are missing

**Output:**

- First, console logs all **completed** concepts
- Then, console logs all **incomplete** concepts (indicating which files are missing)

### `conceptual login`

Authenticates the user with the concept hub. The credentials are stored locally and will be used when publishing concepts.

**Behavior:**

- Prompts the user to input their email
- Prompts the user to input their password
- Stores the credentials locally for future use
- The stored credentials are used automatically when running `conceptual publish`

### `conceptual install {USERNAME}/{CONCEPT_NAME}@{VERSION}`

Installs a publicly available concept from the hub to the local workspace. The username is required, and the version (`@{VERSION}`) is optional. If provided, version must be an integer without decimal points (e.g., `@1`, `@10`, not `@1.0.0`).

**Behavior:**

- Downloads the concept from the public registry using the specified username and concept name
- The concept includes three files: specification, implementation, and test
- Places the files in the correct workspace locations:
  - Specification: `design/concepts/{CONCEPT_NAME}/{CONCEPT_NAME}.md`
  - Implementation: `src/concepts/{CONCEPT_NAME}/{CONCEPT_NAME}Concept.ts`
  - Test: `src/concepts/{CONCEPT_NAME}/{CONCEPT_NAME}Concept.test.ts`
- If version is not specified, installs the latest version

### `conceptual publish {CONCEPT_NAME}`

Publishes a concept from the local workspace to the hub. The concept must be complete (all three required files must exist) before it can be published. Authentication is required (see `conceptual login`).

**Behavior:**

- Requires authentication: the user must have run `conceptual login` previously to store credentials locally
- Validates that the concept exists and is complete in the local workspace:
  - Specification: `design/concepts/{CONCEPT_NAME}/{CONCEPT_NAME}.md`
  - Implementation: `src/concepts/{CONCEPT_NAME}/{CONCEPT_NAME}Concept.ts`
  - Test: `src/concepts/{CONCEPT_NAME}/{CONCEPT_NAME}Concept.test.ts`
- If any of the three files are missing, the command fails with an error
- Uses the stored credentials from `conceptual login` to authenticate with the hub
- Publishes the concept to the hub:
  - If it's a new concept (not previously published), publishes as version 1
  - If the concept already exists in the hub, increments the previous version and publishes the new version
