#!/usr/bin/env python3
import json
import sys

# List of forbidden files to block access to
FORBIDDEN_FILES = [
    ".env",
    "settings.local.json",
    "glm.settings.local.json"
]


def is_forbidden_file(name: str) -> bool:
    """Check if the file path contains any forbidden file names."""
    name_lower = name.lower()
    for forbidden in FORBIDDEN_FILES:
        if forbidden.lower() in name_lower:
            return True
    return False


def main():
    try:
        data = json.load(sys.stdin)
        tool_name = data.get("tool_name", "")
        tool_input = data.get("tool_input", {})
        file_path = tool_input.get("file_path", "")

        # Check if this is a file access operation on a forbidden file
        if file_path and is_forbidden_file(file_path):
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": f"Access denied: {file_path} is a protected file"
                }
            }
            print(json.dumps(output))
            sys.exit(0)

        # Allow access for non-forbidden files
        sys.exit(0)

    except Exception as e:
        print(f"Hook error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
