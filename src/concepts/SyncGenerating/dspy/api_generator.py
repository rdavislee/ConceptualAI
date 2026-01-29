import dspy
import json
import sys
from typing import List, Dict, Any
from pydantic import BaseModel, Field

class EndpointInfo(BaseModel):
    method: str
    path: str
    summary: str
    description: str

class EndpointsList(BaseModel):
    endpoints: List[EndpointInfo]

class GenerateOpenApi(dspy.Signature):
    """Generate an OpenAPI 3.0 YAML definition for the application based on the plan and concepts.
    
    The API should cover all user flows described in the plan.
    Endpoints should be flow-driven, not just exposing concepts directly.
    All requests go through a central Requesting concept, so we define the logical API surface here.
    """
    
    plan: str = dspy.InputField(desc="The application plan describing user stories and flows.")
    concept_specs: str = dspy.InputField(desc="Specifications of all concepts available in the system.")
    guidelines: str = dspy.InputField(desc="API design guidelines.")
    
    openapi_yaml: str = dspy.OutputField(desc="Complete OpenAPI 3.0 YAML string.")
    endpoints_json: str = dspy.OutputField(desc="A JSON list of endpoint objects, each with 'method', 'path', 'summary', 'description'.")

class ApiGenerator(dspy.Module):
    def __init__(self):
        super().__init__()
        self.generator = dspy.ChainOfThought(GenerateOpenApi)
        
    def generate(self, plan: Dict[str, Any], concept_specs: str) -> Dict[str, Any]:
        """
        Generates OpenAPI YAML and a list of endpoints.
        """
        guidelines = (
            "1. Define endpoints based on user flows (e.g., 'Create Project', 'Add Comment'), not just concept CRUD.\n"
            "2. Ensure all logical steps in the plan have corresponding API endpoints.\n"
            "3. Use standard HTTP methods (GET, POST, PUT, DELETE).\n"
            "4. Return a JSON list of endpoints in `endpoints_json` for downstream processing.\n"
            "5. CRITICAL: Do NOT include fields or parameters (like 'tags', 'labels', 'category') unless a supporting concept (e.g., 'Labeling', 'Categorizing') exists in `concept_specs`. If the plan mentions a feature but no corresponding concept exists, OMMIT that feature from the API to avoid implementation errors."
        )
        
        pred = self.generator(
            plan=json.dumps(plan, indent=2),
            concept_specs=concept_specs,
            guidelines=guidelines
        )
        
        # Parse endpoints_json
        endpoints = []
        try:
            # Clean markdown code blocks if present
            json_str = pred.endpoints_json.strip()
            if json_str.startswith("```json"):
                json_str = json_str[7:]
            if json_str.startswith("```"):
                json_str = json_str[3:]
            if json_str.endswith("```"):
                json_str = json_str[:-3]
            
            endpoints = json.loads(json_str.strip())
        except Exception as e:
            print(f"Error parsing endpoints JSON: {e}", file=sys.stderr)
            # Fallback: try to extract from YAML if JSON fails (not implemented here for brevity, assuming CoT works)
            
        return {
            "openapi_yaml": pred.openapi_yaml,
            "endpoints": endpoints
        }
