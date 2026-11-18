from types import SimpleNamespace

import pytest
from pydantic import BaseModel

from app.ai.eval.usage import ModelUsage, recorded_gemini_calls, summarize_calls
from app.ai.llm.providers import GeminiProvider


class Answer(BaseModel):
    value: str


class OneAnswerModels:
    async def generate_content(self, **kwargs):
        return SimpleNamespace(
            text='{"value": "ok"}',
            usage_metadata=SimpleNamespace(
                prompt_token_count=120,
                cached_content_token_count=0,
                candidates_token_count=30,
                thoughts_token_count=5,
            ),
        )


def provider() -> GeminiProvider:
    client = SimpleNamespace(aio=SimpleNamespace(models=OneAnswerModels()))
    return GeminiProvider(api_key="test-key", client=client)


@pytest.mark.asyncio
async def test_gemini_calls_made_inside_the_block_are_summed_per_response_model():
    gemini = provider()

    with recorded_gemini_calls() as calls:
        await gemini.generate("Q", response_model=Answer)
        await gemini.generate("Q", response_model=Answer)
    await gemini.generate("Q", response_model=Answer)

    assert summarize_calls(calls) == [
        ModelUsage(
            response_model="Answer",
            calls=2,
            failed_calls=0,
            prompt_tokens=240,
            output_tokens=60,
            thinking_tokens=10,
        )
    ]
