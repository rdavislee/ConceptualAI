import dspy
from pydantic import BaseModel, Field

class ReadmeSignature(dspy.Signature):
    """Generate a comprehensive README.md for a Deno/TypeScript backend project."""
    
    project_plan = dspy.InputField(desc="The project plan and description")
    api_endpoints = dspy.InputField(desc="List of API endpoints")
    tech_stack = dspy.InputField(desc="Details about the tech stack (Deno, MongoDB, Concepts)")
    
    readme_markdown = dspy.OutputField(desc="The complete README.md content")

class ApiDocSignature(dspy.Signature):
    """Generate user-friendly API documentation (API.md) from an OpenAPI definition."""
    
    openapi_yaml = dspy.InputField(desc="The OpenAPI specification in YAML format")
    context_docs = dspy.InputField(desc="Guidelines for API documentation")
    
    api_markdown = dspy.OutputField(desc="The complete API.md content")

class DocGenerator:
    def __init__(self):
        self.readme_predictor = dspy.ChainOfThought(ReadmeSignature)
        self.api_predictor = dspy.ChainOfThought(ApiDocSignature)

    def generate_readme(self, plan: str, endpoints: str, tech_stack: str) -> str:
        prediction = self.readme_predictor(
            project_plan=plan,
            api_endpoints=endpoints,
            tech_stack=tech_stack
        )
        return prediction.readme_markdown

    def generate_api_doc(self, openapi_yaml: str, context_docs: str) -> str:
        prediction = self.api_predictor(
            openapi_yaml=openapi_yaml,
            context_docs=context_docs
        )
        return prediction.api_markdown
