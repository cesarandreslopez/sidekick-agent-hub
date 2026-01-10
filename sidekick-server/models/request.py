"""Request models for the completion API."""

from typing import Literal, Optional

from pydantic import BaseModel, Field


class CompletionRequest(BaseModel):
    """Request model for code completion."""

    prefix: str = Field(..., max_length=50000, description="Code before cursor")
    suffix: str = Field(default="", max_length=50000, description="Code after cursor")
    language: str = Field(..., min_length=1, description="Programming language")
    filename: Optional[str] = Field(default=None, description="Source filename")
    model: Literal["haiku", "sonnet"] = Field(
        default="haiku", description="Model to use"
    )
    max_tokens: Optional[int] = Field(
        default=None, description="Deprecated: ignored by SDK"
    )
    multiline: bool = Field(default=False, description="Enable multi-line mode")


class ModifyRequest(BaseModel):
    """Request model for code modification."""

    code: str = Field(..., max_length=50000, description="Code to modify")
    instruction: str = Field(..., max_length=1000, description="Modification instruction")
    language: str = Field(..., min_length=1, description="Programming language")
    filename: Optional[str] = Field(default=None, description="Source filename")
    model: Literal["haiku", "sonnet", "opus"] = Field(
        default="opus", description="Model to use"
    )
    prefix: str = Field(default="", max_length=50000, description="Context before selection")
    suffix: str = Field(default="", max_length=50000, description="Context after selection")
