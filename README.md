# cf_ai_assignment

Minimal AI-powered chat app using:

- Workers AI (Llama 3.1)
- Worker + Durable Object (workflow + memory)
- Simple chat UI served from the Worker

---

## Requirement Mapping

### LLM — Workers AI
- Binding in `wrangler.jsonc`:
  "ai": { "binding": "AI" }

- Model call in `src/index.ts`:
  env.AI.run("@cf/meta/llama-3.1-8b-instruct", { messages })

---

### Workflow / Coordination — Worker + Durable Object
- GET / → serves chat UI
- POST /api/chat → routes to Durable Object instance
- Durable Object:
  - Loads history from state.storage
  - Calls Workers AI
  - Stores updated history
  - Returns { reply }

---

### User Input — Chat UI
- Minimal HTML page returned by Worker
- Sends JSON to /api/chat

---

### Memory / State — Durable Object
- History stored via:
  this.state.storage.get("history")
  this.state.storage.put("history", history)

- Session tracked via cookie
- Keeps last MAX_HISTORY messages

---

## Endpoints

- GET / → Chat UI
- POST /api/chat → { message } → { reply }

---

## Local Development

Run locally (Durable Object runs locally):

cd proud-firefly-5d44
npm install
npx wrangler dev --config wrangler.dev.jsonc

Open:
http://localhost:8787


---

## Deploy

cd proud-firefly-5d44
npx wrangler deploy

Wrangler outputs a *.workers.dev URL.

---

## Structure

- wrangler.jsonc — Production config (AI + DO bindings)
- wrangler.dev.jsonc — Local dev config
- src/index.ts — Worker + Durable Object implementation