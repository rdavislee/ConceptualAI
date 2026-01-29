import dspy
import os
import json
import sys
from typing import List, Optional, Dict, Any
from dotenv import load_dotenv

load_dotenv()

# Configure Gemini
api_key = os.getenv("GEMINI_API_KEY")
model_name = os.getenv("GEMINI_MODEL", "gemini-1.5-pro")

if not api_key:
    print("Warning: GEMINI_API_KEY not found in environment variables.")

# Ensure model name is correctly prefixed for litellm
if not model_name.startswith("gemini/") and "gemini" in model_name:
    model_name = f"gemini/{model_name}"

lm = dspy.LM(model=model_name, api_key=api_key, cache=False)
dspy.settings.configure(lm=lm)

from pydantic import BaseModel, Field

class PlanOutput(BaseModel):
    """The structured plan output."""
    summary: str
    entities: List[Dict[str, Any]]
    user_flows: List[Dict[str, Any]]
    pages: List[Dict[str, Any]]
    technical_requirements: List[str]

class PlanningSignature(dspy.Signature):
    """Analyze app description and produce a detailed feature plan.
    
    The plan should be agnostic to specific 'Concept' names but structured enough for an architect to infer them.
    Focus on Entities (Data), User Flows (Actions), and Pages (Queries).
    """
    
    app_description: str = dspy.InputField(desc="The user's description of the application.")
    context_docs: str = dspy.InputField(desc="Background documentation on the concept architecture style.")
    clarification_history: str = dspy.InputField(desc="Previous Q&A pairs, if any. Use this to refine the plan.")
    
    needs_clarification: bool = dspy.OutputField(desc="True if the core purpose is too ambiguous to plan.")
    questions: List[str] = dspy.OutputField(desc="Clarifying questions if needs_clarification is True. Empty otherwise.")
    plan: Optional[PlanOutput] = dspy.OutputField(desc="The structured plan. Null/Empty if needs_clarification is True.")

class ModifyPlanSignature(dspy.Signature):
    """Modify an existing plan based on user feedback."""
    
    current_plan: str = dspy.InputField(desc="The existing JSON plan.")
    feedback: str = dspy.InputField(desc="User feedback requesting changes.")
    context_docs: str = dspy.InputField(desc="Background documentation on the concept architecture style.")
    
    modified_plan: PlanOutput = dspy.OutputField(desc="The updated structured plan.")

class Planner:
    def __init__(self):
        self.context = self._load_context()
        self.predictor = dspy.ChainOfThought(PlanningSignature)
        self.modifier = dspy.ChainOfThought(ModifyPlanSignature)

    def _load_context(self) -> str:
        """Loads relevant background documentation to prime the planner."""
        docs = []
        try:
            # We assume the script is run from src/concepts/Planning/dspy/
            # and the repo root is ../../../../
            # However, when running with python src/concepts/Planning/dspy/main.py from root,
            # we need to adjust or use absolute paths.
            
            # Using absolute path relative to this file
            current_dir = os.path.dirname(os.path.abspath(__file__))
            # We are in src/concepts/Planning/dspy/
            # We want to go to design/background/
            # So ../../../../design/background
            # BUT dspy/ is 1, Planning/ is 2, concepts/ is 3, src/ is 4.
            # So ../../../../ gets to root.
            
            repo_root = os.path.abspath(os.path.join(current_dir, "../../../../"))
            base_path = os.path.join(repo_root, "design/background")
            
            files_to_read = [
                "implementing-concepts.md",
                "implementing-synchronizations.md",
                "concept-design-overview.md"
            ]
            
            for f in files_to_read:
                path = os.path.join(base_path, f)
                if os.path.exists(path):
                    with open(path, "r", encoding="utf-8") as file:
                        docs.append(f"--- {f} ---\n{file.read()}\n")
                else:
                    print(f"Warning: Context file not found at {path}")
                    
        except Exception as e:
            print(f"Error loading context: {e}")
            return ""
            
        return "\n".join(docs)

    def generate_plan(self, description: str, clarification_history: List[Dict[str, str]] = None) -> Dict[str, Any]:
        """Generates a plan or questions based on description and optional history."""
        
        history_str = ""
        if clarification_history:
            history_str = json.dumps(clarification_history, indent=2)
            
        # Call DSPy
        prediction = self.predictor(
            app_description=description,
            context_docs=self.context,
            clarification_history=history_str
        )
        
        result = {
            "status": "complete",
            "plan": None,
            "questions": None
        }

        if prediction.needs_clarification:
            result["status"] = "needs_clarification"
            result["questions"] = prediction.questions
        else:
            # PlanOutput is a Pydantic model, so we dump it to dict
            # dspy.OutputField with Pydantic model returns the model instance
            if prediction.plan:
                # Handle potential case where dspy returns dict instead of model instance
                # though with dspy.BaseModel it should be an object
                if hasattr(prediction.plan, "model_dump"):
                    result["plan"] = prediction.plan.model_dump()
                elif hasattr(prediction.plan, "dict"):
                    result["plan"] = prediction.plan.dict()
                else:
                     result["plan"] = prediction.plan
            else:
                 # Fallback if plan is missing but needs_clarification is false (shouldn't happen with CoT)
                 result["status"] = "error"
                 # Add debug info
                 print(f"DEBUG: Prediction missing plan and needs_clarification=False. Prediction: {prediction}")
                 
        return result

    def clarify_plan(self, description: str, answers: Dict[str, str], previous_clarifications: List[Dict[str, str]]) -> Dict[str, Any]:
        """Refines a plan based on new answers."""
        
        # Merge new answers into history
        # We need to pair them with the questions.
        # Since the API receives just the answers map and previous history (which has Q&A),
        # we append the new ones.
        # NOTE: The caller (PlanningConcept.ts) constructs the full history list including new answers
        # before calling this, or passes them separately.
        # Based on my main.py draft, we receive `answers` and `previous_clarifications`.
        # The planner.py logic above just takes a list of history.
        
        # Let's combine them for the prompt
        full_history = previous_clarifications.copy() if previous_clarifications else []
        for q, a in answers.items():
            full_history.append({"question": q, "answer": a})
            
        return self.generate_plan(description, clarification_history=full_history)

    def modify_plan(self, current_plan: Dict[str, Any], feedback: str) -> Dict[str, Any]:
        """Modifies an existing plan based on feedback."""
        
        plan_str = json.dumps(current_plan, indent=2)
        
        prediction = self.modifier(
            current_plan=plan_str,
            feedback=feedback,
            context_docs=self.context
        )
        
        result = {
            "status": "complete",
            "plan": None
        }
        
        if prediction.modified_plan:
            if hasattr(prediction.modified_plan, "model_dump"):
                result["plan"] = prediction.modified_plan.model_dump()
            elif hasattr(prediction.modified_plan, "dict"):
                result["plan"] = prediction.modified_plan.dict()
            else:
                result["plan"] = prediction.modified_plan
        else:
            result["status"] = "error"
            print(f"DEBUG: Modification failed to return a plan. Prediction: {prediction}")
            
        return result
