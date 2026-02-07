import dspy
from pydantic import BaseModel, Field

class ReadmeSignature(dspy.Signature):
    """Generate a comprehensive, developer-friendly README.md for a Deno/TypeScript backend project.

    The README should include:
    1. **Project Title & Overview** — What the app does, in 2-3 sentences.
    2. **Architecture** — Briefly explain the Concept + Sync architecture: concepts are independent modules
       with state/actions/queries, syncs wire them together behind HTTP endpoints.
    3. **Tech Stack** — Runtime, DB, framework, container support.
    4. **Prerequisites** — Deno, MongoDB, Docker (optional).
    5. **Getting Started** — Step-by-step: clone, configure .env, `deno task build`, `deno task start`.
    6. **Project Structure** — Directory tree with short descriptions of key folders/files
       (src/concepts/, src/syncs/, src/engine/, src/utils/, deno.json, openapi.yaml, Dockerfile).
    7. **API Endpoints** — Table or grouped list of all endpoints with method, path, and short description.
    8. **Concepts** — For each concept, a short paragraph: purpose, key actions/queries.
    9. **Environment Variables** — Table of required vars from .env.template.
    10. **Testing** — How to run tests (`deno task test`).
    11. **Docker** — How to build and run via Docker.

    Be thorough — this is the main documentation a developer will read.
    """

    project_plan = dspy.InputField(desc="The project plan and description")
    api_endpoints = dspy.InputField(desc="List of API endpoints with method, path, and summary")
    tech_stack = dspy.InputField(desc="Details about the tech stack (Deno, MongoDB, Concepts + Syncs)")
    background_context = dspy.InputField(desc="Background on the architecture: concept design philosophy, sync wiring, deno.json config, and project structure conventions. Use this to write accurate architecture and structure sections.")

    readme_markdown = dspy.OutputField(desc="The complete README.md content. Be comprehensive — cover all 11 sections listed above. Aim for 300-600 lines of well-structured markdown.")

class DocGenerator:
    def __init__(self):
        self.readme_predictor = dspy.ChainOfThought(ReadmeSignature)

    def generate_readme(self, plan: str, endpoints: str, tech_stack: str, background_context: str = "") -> str:
        prediction = self.readme_predictor(
            project_plan=plan,
            api_endpoints=endpoints,
            tech_stack=tech_stack,
            background_context=background_context
        )
        return prediction.readme_markdown
