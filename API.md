# Cloak API Documentation

## Overview

Cloak provides a chat API powered by state-of-the-art AI models (Groq and NVIDIA). The API handles tool use (web search, weather, calculations, datetime) and extended thinking for complex reasoning tasks.

## API Endpoint

```
POST https://api.usecloak.org/v1/chat
```

## Authentication

The Cloak API is public and doesn't require authentication for guest access. However, you can optionally provide a Supabase JWT token to associate messages with your user account.

### Optional Authentication Header

```
Authorization: Bearer <SUPABASE_JWT_TOKEN>
```

**Supabase Configuration** (for authenticated requests):
- **URL**: `https://kdawsqrrmwirilyhcolk.supabase.co`
- **Anon Key**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtkYXdzcXJybXdpcmlseWhjb2xrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NjUxNjAsImV4cCI6MjA4OTU0MTE2MH0.cMN9V51J3042DrdaDmL7-ro-AMaw-IU47wQLnW2NMBE`

## Request Format

```json
{
  "model": "string",
  "message": "string",
  "chat_history": [
    {
      "role": "user" | "assistant",
      "message": "string"
    }
  ],
  "temperature": 0.7,
  "system_prompt": "string (optional)",
  "extended_thinking": true,
  "imageBase64": "string (optional)",
  "mimeType": "string (optional)"
}
```

### Request Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | Yes | Model identifier (e.g., `"pneuma"`, `"logos"`, `"kairos"`) |
| `message` | string | Yes | The user's message/query |
| `chat_history` | array | No | Previous messages in the conversation (max ~20 messages recommended) |
| `temperature` | number | No | Sampling temperature (0.0–2.0, default: 0.7). Higher = more creative |
| `system_prompt` | string | No | Custom system instructions to customize Cloak's behavior |
| `extended_thinking` | boolean | No | Enable extended thinking for deeper reasoning (default: false) |
| `imageBase64` | string | No | Base64-encoded image data (PNG, JPEG, or WebP) |
| `mimeType` | string | No | MIME type of the image (e.g., `"image/png"`) |

## Response Format

```json
{
  "text": "string",
  "userId": "string",
  "provider": "string",
  "tools_used": ["string"],
  "extended_thinking": boolean
}
```

### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | The AI's response message |
| `userId` | string | User ID (authenticated) or `"guest"` (unauthenticated) |
| `provider` | string | Which AI provider generated the response: `"groq"`, `"nvidia/nemotron"`, or `"groq-fallback"` |
| `tools_used` | array | List of tools invoked during processing (e.g., `"duckduckgo_search"`, `"read_url"`) |
| `extended_thinking` | boolean | Whether extended thinking was enabled for this request |

## Available Tools

The API can automatically invoke these tools when helpful:

- **`duckduckgo_search`** — Search the web for current information, news, or facts
- **`read_url`** — Fetch and extract text content from a specific URL
- **`calculate`** — Evaluate mathematical expressions
- **`get_datetime`** — Get current date and time (UTC and ISO formats)
- **`get_weather`** — Look up current weather for a city or location

## Examples

### Basic Chat Request

```bash
curl -X POST https://api.usecloak.org/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pneuma",
    "message": "What is the capital of France?"
  }'
```

### Request with Chat History

```bash
curl -X POST https://api.usecloak.org/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "logos",
    "message": "Tell me more about it.",
    "chat_history": [
      {
        "role": "user",
        "message": "What is the capital of France?"
      },
      {
        "role": "assistant",
        "message": "The capital of France is Paris."
      }
    ]
  }'
```

### Request with Custom System Prompt

```bash
curl -X POST https://api.usecloak.org/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kairos",
    "message": "Write a poem about the ocean.",
    "system_prompt": "You are a creative poet. Write in a lyrical, expressive style.",
    "temperature": 1.2
  }'
```

### Request with Image

```bash
curl -X POST https://api.usecloak.org/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "logos",
    "message": "What is in this image?",
    "imageBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "mimeType": "image/png"
  }'
```

### Request with Extended Thinking

```bash
curl -X POST https://api.usecloak.org/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kairos",
    "message": "Design a system architecture for a distributed cache.",
    "extended_thinking": true,
    "temperature": 0.5
  }'
```

### Authenticated Request

```bash
curl -X POST https://api.usecloak.org/v1/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SUPABASE_JWT_TOKEN" \
  -d '{
    "model": "pneuma",
    "message": "Hello!"
  }'
```

## Models

Cloak runs several models; they differ in the underlying model and settings, not in personality — every one answers as **Cloak** with the same system prompt (responses report `"model": "Cloak"`).

- **`pneuma`** — Fast, lightweight model for quick responses
- **`logos`** — Balanced model, lower temperature, for precise answers
- **`kairos`** — Deep-reasoning model for complex analysis
- **`linus`** — Code mode. Same Cloak, plus a code playbook (plan → complete runnable code → self-review) appended to the system prompt. Fails over across the strongest free-tier coding models: NVIDIA Kimi K3 → GLM-5.3 → Laguna XS, Groq gpt-oss-120b → Qwen3.8-27B, Gemini Flash → Flash-Lite. Defaults to 8,192 output tokens (max 16,384) since the client usually sends no `max_tokens`.

## Memory & Context Endpoints

Used by the web app's memory system (see `memory-system.md`). Both run on Cloak's cheapest model tier.

### `POST /v1/memory/extract`

```json
{ "turns": [{ "user": "I'm building a budgeting app in Svelte", "assistant": "Nice — ..." }],
  "existing": [{ "path": "project/app.md", "title": "...", "type": "project", "tags": [], "body": "- ..." }],
  "today": "2026-09-26" }
```

Returns `{ "ops": [{ "op": "add" | "update" | "delete", "path": "project/budget-app.md", "title": "...", "type": "project", "tags": ["svelte"], "importance": 0.7, "body": "- ..." }] }` (max 5 ops).

### `POST /v1/context/compress`

`{ "mode": "chunk", "messages": [{ "role": "user", "content": "..." }], "words": 160, "memory": { "existing": [...] } }` (with `memory`, the chunk's turns are also run through memory extraction and the response adds `ops`) or `{ "mode": "merge", "summaries": ["- ...", "- ..."], "words": 300 }` → `{ "summary": "- ..." }`.

### `GET /v1/usage`

Key cooldowns and learned free-tier limits as seen by the serving isolate. Key ids are hashes; no key material.

## Error Handling

If a request fails, the API returns an error response:

```json
{
  "error": "descriptive error message"
}
```

### Common Status Codes

- **200 OK** — Request successful
- **400 Bad Request** — Missing required fields or invalid input
- **500 Internal Server Error** — Service failure (check message for details)
- **503 Service Unavailable** — Service misconfigured or no API keys available

## Rate Limiting

Currently, no rate limiting is enforced. However, the service is subject to:
- Individual API key rate limits from underlying providers (Groq, NVIDIA)
- Supabase Edge Function execution limits (max 60 seconds per request)

## Implementation Details

The Cloak API is built on:
- **Backend**: Supabase Edge Functions (Deno)
- **AI Models**: Groq (Llama 3.3 70B) for reasoning and tool use; NVIDIA Nemotron (Ultra or 70B) for synthesis
- **Tools**: DuckDuckGo web search, weather lookup (wttr.in), URL fetching, math evaluation
- **Architecture**: Two-pass execution when NVIDIA is available (Groq reasons + uses tools → NVIDIA synthesizes), fallback to Groq-only if NVIDIA unavailable

## JavaScript Example

```javascript
const CLOAK_API = 'https://api.usecloak.org';

async function chat(model, message, chatHistory = []) {
  const response = await fetch(CLOAK_API + '/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      message,
      chat_history: chatHistory,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.error) {
    throw new Error(data.error);
  }

  return data.text;
}

// Usage
const reply = await chat('pneuma', 'What is the weather in San Francisco?');
console.log(reply);
```

## Python Example

```python
import requests
import json

CLOAK_API = 'https://api.usecloak.org'

def chat(model, message, chat_history=None):
    if chat_history is None:
        chat_history = []
    
    payload = {
        'model': model,
        'message': message,
        'chat_history': chat_history,
        'temperature': 0.7,
    }
    
    response = requests.post(
        CLOAK_API + '/v1/chat',
        json=payload,
        headers={'Content-Type': 'application/json'}
    )
    
    response.raise_for_status()
    data = response.json()
    
    if 'error' in data:
        raise Exception(data['error'])
    
    return data['text']

# Usage
reply = chat('pneuma', 'What is the weather in San Francisco?')
print(reply)
```

## Known Limitations

- Maximum ~20 messages in chat history for best performance
- Image analysis may have variable quality depending on model
- Web search results depend on DuckDuckGo availability
- API responses are subject to underlying provider rate limits and availability
- Extended thinking increases response time and token usage

## Support

For issues or questions, contact the Cloak team or check the main repository.
