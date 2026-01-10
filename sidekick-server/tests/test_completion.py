"""Tests for completion service logic."""


from services.completion import clean_completion


class TestCleanCompletion:
    """Tests for the clean_completion function."""

    def test_removes_markdown_code_blocks(self):
        """Should remove markdown code blocks."""
        text = "```python\nprint('hello')\n```"
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == "print('hello')"
        assert reason is None

    def test_removes_markdown_with_language(self):
        """Should remove markdown with language identifier."""
        text = "```typescript\nconst x = 42;\n```"
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == "const x = 42;"
        assert reason is None

    def test_strips_whitespace(self):
        """Should strip leading and trailing whitespace."""
        text = "   hello world   "
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == "hello world"
        assert reason is None

    def test_filters_conversational_i_need(self):
        """Should filter 'I need...' responses."""
        text = "I need more context to complete this."
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == ""
        assert reason is not None

    def test_filters_conversational_i_cannot(self):
        """Should filter 'I cannot...' responses."""
        text = "I cannot provide a completion without more information."
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == ""
        assert reason is not None

    def test_filters_conversational_could_you(self):
        """Should filter 'Could you...' responses."""
        text = "Could you provide more context?"
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == ""
        assert reason is not None

    def test_filters_more_context(self):
        """Should filter responses mentioning 'more context'."""
        text = "This requires more context to answer properly."
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == ""
        assert reason is not None

    def test_filters_cannot_provide(self):
        """Should filter 'cannot provide' responses."""
        text = "I cannot provide this completion."
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == ""
        assert reason is not None

    def test_filters_please_provide(self):
        """Should filter 'please provide' responses."""
        text = "Please provide the full code context."
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == ""
        assert reason is not None

    def test_filters_let_me(self):
        """Should filter 'let me' responses."""
        text = "Let me explain what this code does."
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == ""
        assert reason is not None

    def test_filters_however(self):
        """Should filter responses containing 'however'."""
        text = "42; however, this might not be correct."
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == ""
        assert reason is not None

    def test_filters_without_additional(self):
        """Should filter 'without additional' responses."""
        text = "I can't help without additional information."
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == ""
        assert reason is not None

    def test_filters_too_long(self):
        """Should filter responses exceeding max length."""
        text = "x" * 201
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == ""
        assert reason is not None
        assert "too long" in reason

    def test_accepts_at_max_length(self):
        """Should accept responses at exactly max length."""
        text = "x" * 200
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == "x" * 200
        assert reason is None

    def test_accepts_valid_code(self):
        """Should accept valid code completions."""
        text = "42"
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == "42"
        assert reason is None

    def test_accepts_multiline_code(self):
        """Should accept valid multiline code."""
        text = "def hello():\n    return 'world'"
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == text
        assert reason is None

    def test_multiline_max_length(self):
        """Should use different max length for multiline mode."""
        text = "x" * 500
        # Single-line mode (200 max)
        cleaned, reason = clean_completion(text, max_length=200)
        assert cleaned == ""
        assert reason is not None

        # Multiline mode (1000 max)
        cleaned, reason = clean_completion(text, max_length=1000)
        assert cleaned == "x" * 500
        assert reason is None
