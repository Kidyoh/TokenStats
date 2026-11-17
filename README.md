# Session Browser

Browse and read your local AI coding sessions from **Claude Code**, **Codex**, **OpenCode**, **Grok**, **Antigravity** and **Cursor**, and see where your tokens went.

Everything runs in the visitor's browser. People pick (or drag in) their own session folders, and the files are parsed on their device in Web Workers. The deployed site is a static page with no backend, and nothing is sent anywhere unless the visitor uses **Send to Worklog** (below), which sends a short, redacted description of the sessions they choose to their own Worklog account. Fonts are self-hosted. The only outside request is a download of the public price list from [models.dev](https://models.dev/api.json) (cached for six hours; a copy bundled at build time is the fallback), and nothing about your sessions is sent with it.

## What it reads

| Tool | Folder to pick | Contents | Token data |
|---|---|---|---|
| Claude Code | `~/.claude` | `projects/<project>/<session>.jsonl`, plus `<session>/subagents/*.jsonl` | yes |
| Codex | `~/.codex` | `sessions/**/rollout-*.jsonl`, `archived_sessions/*.jsonl.zst`, `session_index.jsonl` (titles) | yes |
| OpenCode | `~/.local/share/opencode` | `opencode.db` (SQLite) and `opencode.db-wal` | yes |
| Grok | `~/.grok` | `sessions/<cwd>/<id>/{chat_history.jsonl, summary.json, usage.json}` | newer sessions (`usage.json`) |
| Antigravity | `~/.gemini/antigravity` | `conversations/<id>.db` (SQLite with protobuf steps), `conversation_summaries.db` | yes (inferred, see below) |
| Cursor | `~/.cursor` | `projects/<project>/agent-transcripts/<id>/<id>.jsonl`, plus `<id>/subagents/*.jsonl` | estimated (see below) |

On Windows, `~` is `%USERPROFILE%`. The folder pickers start in Documents, one level below these folders on a default install.

Limits:

- **Antigravity** has no published schema. Its protobuf field numbers were mapped by hand (`src/lib/parsers/antigravity.ts`), so its token counts are a best-effort reading.
- **Cursor** transcripts don't record tool output, token usage or per-message times. Cursor's older in-editor chat history lives in one multi-GB database, which is too large for a browser tab, so it isn't read.
- **Estimated tokens**: when a tool records no usage (Cursor, older Grok sessions), tokens are counted from the transcript with the o200k tokenizer (`src/lib/estimate.ts`). Each model call is counted as re-sending the conversation so far (new text as input, the rest as cache reads), with the context compacted when it passes 200k. System prompts, tool definitions and Cursor's unrecorded tool output aren't included, and no model is recorded, so there's no cost. These numbers show with a `~`.
- **Grok** cost is converted from xAI's "USD ticks" at 10¹⁰ ticks per dollar.

## Features

- Overview: total tokens and estimated cost (models.dev list prices), per tool, per model and per day; largest sessions. A date range (7, 30, 90 days, 12 months or all time) applies to the list and every page.
- **Share**: turns the overview into a 1200×675 PNG (totals, daily chart, tools, top models) to download or copy. It shows totals only: no titles, prompts or folders.
- **Tools** page: every tool your agents called, ranked, with sessions, which apps used it, failure rate and average time; calls by kind; the shell programs run most; MCP servers.
- **Time** page: active hours (gaps over 30 minutes between messages left out), active days and streaks, a weekday × hour heatmap, time per day, project and tool, and the longest sessions by active time. Tools that don't record message times (Cursor) are left out.
- Sessions list with tool filters, sort, folder filter, and full-text search inside conversations
- Conversation reader: chat-style messages, with tool calls shown as compact steps that expand into the command, a diff for edits, parameters and output. Thinking and injected context can be shown or hidden.
- **Remove sensitive info**: hides API keys and tokens (OpenAI, Anthropic, GitHub, AWS, Google, Stripe, Slack, Telegram, JWTs and more), private keys, passwords in URLs, secret-looking `KEY=value` and JSON fields, `.env` and other credential-file contents read or written by tools, emails, and your username, which is learned from home-folder paths and hidden wherever it appears. It's pattern-based: a strong safety net, not a guarantee.
- **Export**, for one session or the whole filtered list:
  - *Normal*: Markdown transcript or full JSON; redaction optional
  - *AI training data*: JSONL in the standard chat fine-tuning shape (`{"messages":[…], "metadata":{…}}` with `tool_calls` and `tool` messages). Redaction is always on; injected system context is dropped; tool calls without a recorded result are left out; long tool output is capped.
- **Send to Worklog**: adds one session, or the whole filtered list, to your timeline on [Worklog](https://worklog.pro.et) with your own API key. Off until you use it, and nothing is sent until you click Send after reviewing a preview of every entry.
  - Each entry has: a title, a 1–3 sentence summary of the first prompt, the project folder's name (not its path), the agent and model names, the start time and the active time (gaps of more than 30 minutes between messages are left out).
  - Never sent: conversation text, tool calls or output, code, file paths, links, branch names, tokens or cost. Redaction always runs first.
  - Each entry carries `external_id` `session-browser:<session id>`, so sending a session again updates its entry instead of adding a duplicate. Subagent sessions are left out of list sends, since they're part of their parent's work.
  - Sent sessions are marked in the list and in the conversation view ("In Worklog"), and turn amber when the session has continued since it was sent. These marks are kept in this browser only.
  - It calls Worklog's MCP endpoint (`https://worklog.pro.et/api/mcp`, `log_work` tool) from the browser, with the key in an `Authorization` header. The key is kept in memory, or in this browser's localStorage if you tick "Remember on this device".
- Picked folders are remembered in the browser, and the last sync is shown right away on return. **Sync** reads them again (Chromium may ask for one click to re-allow access). Other browsers can drag folders in.
- With **Remove sensitive info** on, a session shows how many items were hidden and a list of them, grouped by type, with a jump to where each appears.
- Parsed summaries are cached in IndexedDB, so unchanged files aren't re-read.

## Code map

- `src/lib/parsers/`: one parser per tool, plus `sqlite-wal.ts` (folds a WAL file into the db image), `protobuf.ts` (schema-less reader) and `common.ts`
- `src/lib/worker/`: Web Worker pool that receives `File`s and returns summaries or messages
- `src/lib/sources.ts`: walks picked or dropped folders, visiting only the subfolders that can hold sessions
- `src/lib/store.svelte.ts`: app state, cache, remembered folders
- `src/lib/redact.ts`, `src/lib/export.ts`, `src/lib/toolinfo.ts`: redaction, export formats, tool-call presentation
- `src/lib/stats.ts`: per-session tool and time statistics, worked out in the parse worker and cached with each summary
- `src/lib/sharecard.ts`: draws the shareable PNG on a canvas
- `src/lib/worklog.ts`, `src/lib/components/WorklogDialog.svelte`: Send to Worklog (entry mapping, MCP client, dialog)
- `prototype/`: the first version, a stdlib-only Python server (`python prototype/server.py`); not part of the site

## Develop

```bash
npm install
npm run dev
```

```bash
npm test          # parser, redaction, export and Worklog tests; parser tests also run against your own session folders if present
npm run check     # type check
```

## Deploy to Vercel

Push the repo to GitHub and import it at vercel.com/new, or run:

```bash
npx vercel
```
