"""
Registry of agent task types.

Each entry describes the task type label and a human-readable description.
The frontend uses GET /api/agent-tasks/task-types to populate the task-type
dropdown and to know which config form to render per type.
"""

TASK_TYPES: dict[str, dict] = {
    "screener": {
        "label":       "Internal Screener Run",
        "description": "Run an internal screener config against a watchlist "
                       "and record which symbols pass.",
    },
    "finviz_screen": {
        "label":       "Finviz Screener",
        "description": "Screen symbols on Finviz.com using filters/signals "
                       "and optionally save results as a new watchlist.",
    },
}


def all_task_types() -> list[dict]:
    return [{"key": k, **v} for k, v in TASK_TYPES.items()]
