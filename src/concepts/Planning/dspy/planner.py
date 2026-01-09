import dspy

class PlanningSignature(dspy.Signature):
    """Analyze app description and either produce a plan or ask clarifying questions."""
    
    app_description: str = dspy.InputField()
    available_concepts: str = dspy.InputField()
    clarification_history: str = dspy.InputField(desc="Previous Q&A, empty if first pass")
    
    needs_clarification: bool = dspy.OutputField(desc="True if questions needed")
    questions: list[str] = dspy.OutputField(desc="Questions to ask user, empty if not needed")
    plan: dict = dspy.OutputField(desc="The plan, empty if clarification needed")

class Planner:
    def __init__(self):
        pass

    def generate_plan(self, description: str, clarification_history: list = None):
        pass

