export interface Env {
  AI?: any;
  CHATROOMS: DurableObjectNamespace;
}

type ChatMessage = { role: "user" | "assistant"; content: string };

const MODEL = "@cf/meta/llama-3.1-8b-instruct";
const SYSTEM_PROMPT =
  "You are a concise, helpful assistant. Keep answers short and practical.";
const MAX_HISTORY = 20;

// ----- small cookie helpers -----
function getCookie(req: Request, name: string): string | null {
  const cookie = req.headers.get("Cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function makeSessionCookie(sessionId: string, secure: boolean): string {
  return `session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${
    secure ? "; Secure" : ""
  }`;
}

// ----- minimal UI -----
function htmlPage(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Workers AI Chat (DO Memory)</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; max-width: 820px; }
      h1 { font-size: 18px; margin: 0 0 12px; }
      #chat { border: 1px solid #ddd; border-radius: 10px; padding: 12px; height: 60vh; overflow: auto; background: #fafafa; }
      .msg { margin: 10px 0; white-space: pre-wrap; }
      .user { font-weight: 600; }
      form { display: flex; gap: 8px; margin-top: 12px; }
      input { flex: 1; padding: 10px; border-radius: 10px; border: 1px solid #ddd; }
      button { padding: 10px 14px; border-radius: 10px; border: 1px solid #ddd; background: white; cursor: pointer; }
      .hint { color: #666; font-size: 12px; margin-top: 10px; }
    </style>
  </head>
  <body>
    <h1>Workers AI Chat (Worker + Durable Object memory)</h1>
    <div id="chat"></div>

    <form id="form">
      <input id="msg" autocomplete="off" placeholder="Type a message..." />
      <button type="submit">Send</button>
    </form>

    <div class="hint">
      Session memory is stored per-browser via a cookie. No auth. Minimal demo.
    </div>

    <script>
      const chat = document.getElementById("chat");
      const form = document.getElementById("form");
      const input = document.getElementById("msg");

      function add(role, text) {
        const div = document.createElement("div");
        div.className = "msg " + role;
        div.textContent = (role === "user" ? "You: " : "AI: ") + text;
        chat.appendChild(div);
        chat.scrollTop = chat.scrollHeight;
        return div;
      }

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const message = input.value.trim();
        if (!message) return;
        input.value = "";
        add("user", message);

        const placeholder = add("assistant", "…");

        try {
          const res = await fetch("/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message }),
          });
          const ct = res.headers.get("content-type") || "";
          if (!res.ok) {
            const t = await res.text();
            placeholder.textContent = "AI: [server error] " + t;
            return;
          }
          if (!ct.includes("application/json")) {
            const t = await res.text();
            placeholder.textContent = "AI: [non-json response] " + t;
            return;
          }
          const data = await res.json();
          placeholder.textContent = "AI: " + (data.reply || "[no reply]");
        } catch (err) {
          placeholder.textContent = "AI: [error] " + err;
        }
      });

      add("assistant", "Hi! Ask me something.");
    </script>
  </body>
</html>`;
}

// ----- Worker -----
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({
        ok: true,
        hasAI: !!env.AI,
        hasDO: !!env.CHATROOMS,
        ts: new Date().toISOString(),
      });
    }
    // GET / -> UI
    if (request.method === "GET" && url.pathname === "/") {
      let sessionId = getCookie(request, "session");
      const secure = url.protocol === "https:";
      const headers: Record<string, string> = {
        "content-type": "text/html; charset=utf-8",
      };
      if (!sessionId) {
        sessionId = crypto.randomUUID();
        headers["set-cookie"] = makeSessionCookie(sessionId, secure);
      }
      return new Response(htmlPage(), { headers });
    }

    // POST /api/chat -> route to DO by session cookie
    if (request.method === "POST" && url.pathname === "/api/chat") {
      let sessionId = getCookie(request, "session");
      const secure = url.protocol === "https:";
      let setCookie: string | null = null;

      if (!sessionId) {
        sessionId = crypto.randomUUID();
        setCookie = makeSessionCookie(sessionId, secure);
      }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const message = (body?.message ?? "").toString().trim();
      if (!message) return Response.json({ error: "Missing message" }, { status: 400 });

      const id = env.CHATROOMS.idFromName(sessionId);
      const stub = env.CHATROOMS.get(id);

      let doResp: Response;
      try {
        doResp = await stub.fetch("https://do/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message }),
        });
      } catch (err) {
        return Response.json(
          { error: "Failed to reach Durable Object", details: String(err) },
          { status: 502 }
        );
      }

      const ct = doResp.headers.get("content-type") || "";
      const raw = await doResp.text();

      let parsed: any = null;
      if (ct.includes("application/json")) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          return Response.json(
            { error: "DO returned invalid JSON", raw },
            { status: 502 }
          );
        }
      } else {
        return Response.json(
          { error: "DO returned non-JSON response", raw },
          { status: 502 }
        );
      }

      if (!doResp.ok) {
        return Response.json(
          { error: "Durable Object error", ...parsed },
          { status: doResp.status }
        );
      }

      const headers: HeadersInit = { "content-type": "application/json" };
      if (setCookie) (headers as any)["set-cookie"] = setCookie;

      return new Response(JSON.stringify({ reply: parsed.reply }), {
        status: 200,
        headers,
      });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export class ChatRoom {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") {
        return Response.json({ error: "Method not allowed" }, { status: 405 });
      }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON" }, { status: 400 });
      }

      const message = (body?.message ?? "").toString().trim();
      if (!message) return Response.json({ error: "Missing message" }, { status: 400 });

      const history = ((await this.state.storage.get("history")) as ChatMessage[]) ?? [];

      history.push({ role: "user", content: message });
      while (history.length > MAX_HISTORY) history.shift();

      const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...history];

      let reply = "";

      if (!this.env.AI) {
        reply = `DEV MODE (no Workers AI). You said: ${message}`;
      } else {
        let aiResult: any;
        try {
          aiResult = await this.env.AI.run(MODEL, {
            messages,
            max_tokens: 256,
            temperature: 0.6,
          });
        } catch (err) {
          return Response.json(
            { error: "Workers AI call failed", details: String(err) },
            { status: 502 }
          );
        }

        reply = (aiResult?.response ?? "").toString().trim();
        if (!reply) {
          return Response.json(
            { error: "Empty AI response", aiResult },
            { status: 502 }
          );
        }
      }

      history.push({ role: "assistant", content: reply });
      while (history.length > MAX_HISTORY) history.shift();

      await this.state.storage.put("history", history);

      return Response.json({ reply });
    } catch (err) {
      return Response.json(
        { error: "Unhandled DO exception", details: String(err) },
        { status: 500 }
      );
    }
  }
}
