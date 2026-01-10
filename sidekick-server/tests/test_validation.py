"""Tests for request validation via Pydantic models."""

import pytest
from pydantic import ValidationError

from models.request import CompletionRequest


def test_accept_valid_minimal_request():
    """Should accept valid minimal request."""
    request = CompletionRequest(prefix="const x = ", language="typescript")
    assert request.prefix == "const x = "
    assert request.language == "typescript"
    assert request.model == "haiku"  # default


def test_accept_valid_full_request():
    """Should accept valid full request."""
    request = CompletionRequest(
        prefix="const x = ",
        suffix=";",
        language="typescript",
        filename="test.ts",
        model="haiku",
        max_tokens=100,
    )
    assert request.prefix == "const x = "
    assert request.suffix == ";"
    assert request.language == "typescript"
    assert request.filename == "test.ts"
    assert request.model == "haiku"
    assert request.max_tokens == 100


def test_reject_missing_prefix():
    """Should reject missing prefix."""
    with pytest.raises(ValidationError) as exc_info:
        CompletionRequest(language="typescript")

    errors = exc_info.value.errors()
    assert any(e["loc"] == ("prefix",) for e in errors)


def test_reject_missing_language():
    """Should reject missing language."""
    with pytest.raises(ValidationError) as exc_info:
        CompletionRequest(prefix="test")

    errors = exc_info.value.errors()
    assert any(e["loc"] == ("language",) for e in errors)


def test_reject_empty_language():
    """Should reject empty language."""
    with pytest.raises(ValidationError) as exc_info:
        CompletionRequest(prefix="test", language="")

    errors = exc_info.value.errors()
    assert any(e["loc"] == ("language",) for e in errors)


def test_reject_invalid_model():
    """Should reject invalid model."""
    with pytest.raises(ValidationError) as exc_info:
        CompletionRequest(prefix="test", language="typescript", model="invalid")

    errors = exc_info.value.errors()
    assert any(e["loc"] == ("model",) for e in errors)


def test_accept_valid_model_haiku():
    """Should accept valid model haiku."""
    request = CompletionRequest(prefix="test", language="typescript", model="haiku")
    assert request.model == "haiku"


def test_accept_valid_model_sonnet():
    """Should accept valid model sonnet."""
    request = CompletionRequest(prefix="test", language="typescript", model="sonnet")
    assert request.model == "sonnet"


def test_reject_prefix_exceeding_max_length():
    """Should reject prefix exceeding max length."""
    with pytest.raises(ValidationError) as exc_info:
        CompletionRequest(prefix="a" * 50001, language="typescript")

    errors = exc_info.value.errors()
    assert any(e["loc"] == ("prefix",) for e in errors)


def test_reject_suffix_exceeding_max_length():
    """Should reject suffix exceeding max length."""
    with pytest.raises(ValidationError) as exc_info:
        CompletionRequest(prefix="test", language="typescript", suffix="a" * 50001)

    errors = exc_info.value.errors()
    assert any(e["loc"] == ("suffix",) for e in errors)


def test_accept_prefix_at_max_length():
    """Should accept prefix at max length."""
    request = CompletionRequest(prefix="a" * 50000, language="typescript")
    assert len(request.prefix) == 50000


def test_default_values():
    """Should use correct default values."""
    request = CompletionRequest(prefix="test", language="typescript")

    assert request.suffix == ""
    assert request.filename is None
    assert request.model == "haiku"
    assert request.max_tokens is None
    assert request.multiline is False
