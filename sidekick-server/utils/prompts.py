"""Prompt loading utilities."""

from pathlib import Path
from functools import lru_cache

# Prompts directory
PROMPTS_DIR = Path(__file__).parent.parent / "prompts"


@lru_cache(maxsize=10)
def load_prompt(name: str) -> str:
    """
    Load a prompt template from the prompts directory.

    Args:
        name: Name of the prompt file (without .md extension)

    Returns:
        The prompt template as a string
    """
    prompt_path = PROMPTS_DIR / f"{name}.md"
    return prompt_path.read_text(encoding="utf-8")


def get_system_prompt(multiline: bool = False) -> str:
    """
    Get the system prompt with appropriate settings.

    Args:
        multiline: Whether multiline mode is enabled

    Returns:
        Formatted system prompt
    """
    template = load_prompt("system")
    block_type = "block/function" if multiline else "line/statement"
    line_limit = "up to 10 lines" if multiline else "1-3 lines"

    return template.format(block_type=block_type, line_limit=line_limit)


def get_user_prompt(
    language: str,
    filename: str,
    prefix: str,
    suffix: str,
) -> str:
    """
    Get the user prompt with code context.

    Args:
        language: Programming language
        filename: Source filename
        prefix: Code before cursor
        suffix: Code after cursor

    Returns:
        Formatted user prompt
    """
    template = load_prompt("user")
    return template.format(
        language=language,
        filename=filename,
        prefix=prefix,
        suffix=suffix,
    )


def get_modify_system_prompt() -> str:
    """
    Get the system prompt for code modification.

    Returns:
        System prompt for modification requests
    """
    return load_prompt("modify_system")


def get_modify_user_prompt(
    language: str,
    code: str,
    instruction: str,
    prefix: str = "",
    suffix: str = "",
) -> str:
    """
    Get the user prompt for code modification.

    Args:
        language: Programming language
        code: Code to modify
        instruction: Modification instruction
        prefix: Optional context before selection
        suffix: Optional context after selection

    Returns:
        Formatted user prompt
    """
    template = load_prompt("modify_user")

    # Build context section if prefix or suffix is provided
    context_parts = []
    if prefix:
        context_parts.append(f"--- CODE BEFORE SELECTION ---\n{prefix}")
    if suffix:
        context_parts.append(f"--- CODE AFTER SELECTION ---\n{suffix}")

    context_section = "\n\n".join(context_parts) + "\n" if context_parts else ""

    return template.format(
        language=language,
        code=code,
        instruction=instruction,
        context_section=context_section,
    )
