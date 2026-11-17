"""Session Browser - browse local Claude Code, Codex and OpenCode sessions.

Stdlib only (Python 3.14+ for archived .zst Codex sessions). Read-only: it never
writes to any session store. Binds to 127.0.0.1 only.

    python server.py            -> http://127.0.0.1:8765
    python server.py --port 9000
"""
import argparse
import glob
import json
import os
import re
import sqlite3
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    from compression import zstd  # Python 3.14+
except ImportError:  # pragma: no cover
    zstd = None

HOME = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(HERE, ".session-index-cache.json")

CLAUDE_DIR = os.path.join(HOME, ".claude", "projects")
CODEX_DIRS = [os.path.join(HOME, ".codex", "sessions"), os.path.join(HOME, ".codex", "archived_sessions")]
OPENCODE_DB = os.path.join(HOME, ".local", "share", "opencode", "opencode.db")

PARSER_VERSION = 2
MAX_TOOL_TEXT = 20000  # truncate huge tool outputs in the viewer


def ms(ts):
    """ISO string / epoch(s|ms) -> epoch ms."""
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return int(ts if ts > 1e11 else ts * 1000)
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None


def clip(s, n=MAX_TOOL_TEXT):
    if s is None:
        return ""
    if not isinstance(s, str):
        s = json.dumps(s, indent=2, ensure_ascii=False)
    return s if len(s) <= n else s[:n] + f"\n\n… [{len(s) - n:,} more characters truncated]"


def empty_tokens():
    return {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0, "reasoning": 0}


def add_tokens(a, b):
    for k in a:
        a[k] += b.get(k, 0) or 0


def read_lines(path):
    if path.endswith(".zst"):
        if not zstd:
            return []
        with open(path, "rb") as f:
            return zstd.decompress(f.read()).decode("utf-8", "replace").splitlines()
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.readlines()


def first_line_text(s, n=160):
    s = " ".join((s or "").split())
    return s[:n]


# --------------------------------------------------------------------- Claude
SKIP_CLAUDE = ('"type":"api-request', '"type":"file-history', '"type":"attachment"', '"type":"queue-operation')


def claude_text_of(content):
    if isinstance(content, str):
        return content
    out = []
    for c in content or []:
        if isinstance(c, dict) and c.get("type") == "text":
            out.append(c.get("text", ""))
    return "\n".join(out)


TAG_BLOCK = re.compile(r"^\s*<([A-Za-z_][\w-]*)[^>]*>.*?</\1>\s*", re.S)


def strip_tag_blocks(t):
    """Drop leading <tag>...</tag> wrappers that clients inject before the real prompt."""
    t = t or ""
    while True:
        m = TAG_BLOCK.match(t)
        if not m:
            return t.strip()
        t = t[m.end():]


def is_meta_prompt(t):
    t = t.lstrip()
    if t.startswith("<") and not strip_tag_blocks(t):
        return True
    return t.startswith(("<system-reminder>", "<command-", "<local-command", "Caveat:", "<environment_context>",
                         "# AGENTS.md", "<user_instructions>", "<permissions", "<ide_"))


def claude_summary(path):
    title = custom = first = None
    cwd = branch = None
    start = end = None
    models = {}
    usage_by_id = {}
    cost = None
    n_user = n_asst = 0
    entrypoint = None
    for line in read_lines(path):
        head = line[:120]
        if any(s in head for s in SKIP_CLAUDE):
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        t = o.get("type")
        ts = ms(o.get("timestamp"))
        if ts:
            start = ts if start is None else min(start, ts)
            end = ts if end is None else max(end, ts)
        if t == "custom-title":
            custom = o.get("customTitle")
        elif t == "cost-state":
            cost = o.get("totalCostUSD")
        elif t == "user":
            cwd = cwd or o.get("cwd")
            branch = branch or o.get("gitBranch")
            entrypoint = entrypoint or o.get("entrypoint")
            c = o.get("message", {}).get("content")
            if isinstance(c, list) and c and all(isinstance(x, dict) and x.get("type") == "tool_result" for x in c):
                continue
            txt = claude_text_of(c)
            if txt and not is_meta_prompt(txt) and not o.get("isMeta"):
                n_user += 1
                if not first:
                    first = strip_tag_blocks(txt)
        elif t == "assistant":
            m = o.get("message", {})
            model = m.get("model")
            u = m.get("usage")
            if model and model != "<synthetic>" and u:
                usage_by_id[m.get("id") or o.get("uuid")] = (model, u)
            n_asst += 1
    tok = empty_tokens()
    for model, u in usage_by_id.values():
        d = {"input": u.get("input_tokens", 0), "output": u.get("output_tokens", 0),
             "cache_read": u.get("cache_read_input_tokens", 0), "cache_write": u.get("cache_creation_input_tokens", 0)}
        add_tokens(tok, d)
        models.setdefault(model, empty_tokens())
        add_tokens(models[model], d)
    title = custom or first_line_text(first) or "(no prompt)"
    return {"title": title, "first_prompt": first_line_text(first, 400), "cwd": cwd, "branch": branch,
            "start": start, "end": end, "tokens": tok, "models": models, "cost": cost,
            "turns": n_user, "messages": n_user + n_asst, "client": entrypoint}


def claude_messages(path):
    out = []
    for line in read_lines(path):
        head = line[:120]
        if any(s in head for s in SKIP_CLAUDE):
            continue
        try:
            o = json.loads(line)
        except Exception:
            continue
        t = o.get("type")
        ts = ms(o.get("timestamp"))
        if t == "user":
            c = o.get("message", {}).get("content")
            if isinstance(c, str):
                c = [{"type": "text", "text": c}]
            for b in c or []:
                if not isinstance(b, dict):
                    continue
                bt = b.get("type")
                if bt == "text":
                    txt = b.get("text", "")
                    out.append({"role": "user", "kind": "meta" if (is_meta_prompt(txt) or o.get("isMeta")) else "text",
                                "text": txt, "time": ts})
                elif bt == "tool_result":
                    rc = b.get("content")
                    if isinstance(rc, list):
                        rc = "\n".join(x.get("text", "[image]" if x.get("type") == "image" else "")
                                       for x in rc if isinstance(x, dict))
                    out.append({"role": "tool", "kind": "tool_result", "text": clip(rc), "id": b.get("tool_use_id"),
                                "error": bool(b.get("is_error")), "time": ts})
                elif bt == "image":
                    src = b.get("source", {})
                    img = f"data:{src.get('media_type')};base64,{src.get('data')}" if src.get("type") == "base64" else None
                    out.append({"role": "user", "kind": "image", "image": img, "time": ts})
        elif t == "assistant":
            m = o.get("message", {})
            u = m.get("usage") or {}
            model = m.get("model")
            for b in m.get("content") or []:
                bt = b.get("type")
                base = {"role": "assistant", "time": ts, "model": model, "sidechain": o.get("isSidechain")}
                if bt == "text":
                    out.append({**base, "kind": "text", "text": b.get("text", "")})
                elif bt == "thinking":
                    if b.get("thinking"):
                        out.append({**base, "kind": "thinking", "text": b.get("thinking")})
                elif bt == "tool_use":
                    out.append({**base, "kind": "tool_call", "name": b.get("name"), "id": b.get("id"),
                                "text": clip(b.get("input"))})
            if out and out[-1]["role"] == "assistant" and u:
                out[-1]["usage"] = {"input": u.get("input_tokens", 0), "output": u.get("output_tokens", 0),
                                    "cache_read": u.get("cache_read_input_tokens", 0),
                                    "cache_write": u.get("cache_creation_input_tokens", 0)}
        elif t == "system" and o.get("content"):
            out.append({"role": "system", "kind": "meta", "text": str(o.get("content")), "time": ts})
        elif t == "summary" and o.get("summary"):
            out.append({"role": "system", "kind": "meta", "text": "Summary: " + o["summary"], "time": ts})
    return out


def scan_claude():
    items = []
    if not os.path.isdir(CLAUDE_DIR):
        return items
    for proj in os.listdir(CLAUDE_DIR):
        pdir = os.path.join(CLAUDE_DIR, proj)
        for f in glob.glob(os.path.join(pdir, "*.jsonl")):
            sid = os.path.basename(f)[:-6]
            subs = glob.glob(os.path.join(pdir, sid, "**", "*.jsonl"), recursive=True)
            items.append({"source": "claude", "id": "claude:" + sid, "path": f, "project_dir": proj,
                          "subagents": [{"id": "claude-sub:" + sid + ":" + os.path.relpath(s, os.path.join(pdir, sid)).replace("\\", "/"),
                                         "path": s} for s in subs]})
    return items


# ---------------------------------------------------------------------- Codex
def codex_content_text(content):
    if isinstance(content, str):
        return content
    out = []
    for c in content or []:
        if isinstance(c, dict):
            if c.get("type") in ("input_text", "output_text", "text"):
                out.append(c.get("text", ""))
            elif c.get("type") in ("input_image", "image"):
                out.append("[image]")
    return "\n".join(out)


def codex_summary(path):
    meta = {}
    model = None
    first = None
    start = end = None
    total = None
    n_user = n_msgs = 0
    title = None
    for line in read_lines(path):
        try:
            o = json.loads(line)
        except Exception:
            continue
        ts = ms(o.get("timestamp"))
        if ts:
            start = ts if start is None else min(start, ts)
            end = ts if end is None else max(end, ts)
        t = o.get("type")
        p = o.get("payload") or {}
        if t == "session_meta":
            meta = p
        elif t == "turn_context":
            model = p.get("model") or model
        elif t == "event_msg" and p.get("type") == "token_count":
            info = p.get("info") or {}
            if info.get("total_token_usage"):
                total = info["total_token_usage"]
        elif t == "event_msg" and p.get("type") == "thread_name_updated":
            title = p.get("thread_name") or title
        elif t == "response_item" and p.get("type") == "message":
            role = p.get("role")
            if role in ("user", "assistant"):
                txt = codex_content_text(p.get("content"))
                if role == "user":
                    if is_meta_prompt(txt):
                        continue
                    n_user += 1
                    first = first or strip_tag_blocks(txt)
                n_msgs += 1
    tok = empty_tokens()
    if total:
        cached = total.get("cached_input_tokens", 0) or 0
        tok = {"input": max((total.get("input_tokens", 0) or 0) - cached, 0), "output": total.get("output_tokens", 0) or 0,
               "cache_read": cached, "cache_write": total.get("cache_write_input_tokens", 0) or 0,
               "reasoning": total.get("reasoning_output_tokens", 0) or 0}
    models = {model: dict(tok)} if model else {}
    return {"title": title or first_line_text(first) or "(no prompt)", "first_prompt": first_line_text(first, 400),
            "cwd": meta.get("cwd"), "branch": (meta.get("git") or {}).get("branch"), "start": start, "end": end,
            "tokens": tok, "models": models, "cost": None, "turns": n_user, "messages": n_msgs,
            "client": meta.get("originator"), "archived": path.endswith(".zst") or "archived_sessions" in path}


def codex_messages(path):
    out = []
    for line in read_lines(path):
        try:
            o = json.loads(line)
        except Exception:
            continue
        ts = ms(o.get("timestamp"))
        t = o.get("type")
        p = o.get("payload") or {}
        if t == "turn_context":
            model = p.get("model")
            if model:
                out.append({"role": "system", "kind": "meta", "text": f"Turn context · model {model} · cwd {p.get('cwd')}", "time": ts})
        elif t == "event_msg" and p.get("type") == "token_count":
            last = (p.get("info") or {}).get("last_token_usage")
            if last:
                for m in reversed(out):
                    if m["role"] == "assistant":
                        cached = last.get("cached_input_tokens", 0) or 0
                        m["usage"] = {"input": (last.get("input_tokens", 0) or 0) - cached, "output": last.get("output_tokens", 0),
                                      "cache_read": cached, "reasoning": last.get("reasoning_output_tokens", 0)}
                        break
        if t != "response_item":
            continue
        pt = p.get("type")
        if pt == "message":
            role = p.get("role")
            txt = codex_content_text(p.get("content"))
            if role == "developer":
                out.append({"role": "system", "kind": "meta", "text": txt, "time": ts})
            elif role in ("user", "assistant"):
                kind = "meta" if role == "user" and is_meta_prompt(txt) else "text"
                out.append({"role": role, "kind": kind, "text": txt, "time": ts})
        elif pt == "reasoning":
            summ = "\n\n".join(s.get("text", "") for s in p.get("summary") or [] if isinstance(s, dict))
            if summ.strip():
                out.append({"role": "assistant", "kind": "thinking", "text": summ, "time": ts})
        elif pt in ("function_call", "custom_tool_call", "local_shell_call", "web_search_call", "tool_search_call"):
            args = p.get("arguments") or p.get("input") or p.get("action")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    pass
            out.append({"role": "assistant", "kind": "tool_call", "name": p.get("name") or pt, "id": p.get("call_id"),
                        "text": clip(args), "time": ts})
        elif pt in ("function_call_output", "custom_tool_call_output", "local_shell_call_output", "tool_search_output"):
            res = p.get("output")
            if isinstance(res, list):
                res = codex_content_text(res)
            elif isinstance(res, dict):
                res = res.get("content") or res
            out.append({"role": "tool", "kind": "tool_result", "text": clip(res), "id": p.get("call_id"), "time": ts})
    return out


CODEX_INDEX = os.path.join(HOME, ".codex", "session_index.jsonl")


def codex_thread_names():
    names = {}
    try:
        for line in read_lines(CODEX_INDEX):
            try:
                o = json.loads(line)
                if o.get("thread_name"):
                    names[o["id"]] = o["thread_name"]
            except Exception:
                pass
    except OSError:
        pass
    return names


def scan_codex():
    items = []
    for d in CODEX_DIRS:
        if not os.path.isdir(d):
            continue
        for f in glob.glob(os.path.join(d, "**", "rollout-*.jsonl*"), recursive=True):
            name = os.path.basename(f).split(".")[0]
            sid = name[-36:]
            items.append({"source": "codex", "id": "codex:" + sid, "path": f, "subagents": []})
    return items


# ------------------------------------------------------------------- OpenCode
def oc_connect():
    return sqlite3.connect(f"file:{OPENCODE_DB}?mode=ro", uri=True, timeout=5)


def scan_opencode():
    if not os.path.exists(OPENCODE_DB):
        return []
    items = []
    try:
        c = oc_connect()
        c.row_factory = sqlite3.Row
        rows = c.execute("select * from session").fetchall()
        firsts = {}
        for r in c.execute("""select p.session_id, json_extract(p.data,'$.text') from part p
                              join message m on m.id=p.message_id
                              where json_extract(m.data,'$.role')='user' and json_extract(p.data,'$.type')='text'
                              order by p.time_created desc"""):
            firsts[r[0]] = r[1]
        counts = {r[0]: (r[1], r[2]) for r in c.execute(
            "select session_id, count(*), sum(json_extract(data,'$.role')='user') from message group by session_id")}
        models = {}
        for r in c.execute("""select session_id, json_extract(data,'$.providerID')||'/'||json_extract(data,'$.modelID'),
                                     sum(json_extract(data,'$.tokens.input')), sum(json_extract(data,'$.tokens.output')),
                                     sum(json_extract(data,'$.tokens.cache.read')), sum(json_extract(data,'$.tokens.cache.write')),
                                     sum(json_extract(data,'$.tokens.reasoning'))
                              from message where json_extract(data,'$.role')='assistant' group by 1,2"""):
            models.setdefault(r[0], {})[r[1]] = {"input": r[2] or 0, "output": r[3] or 0, "cache_read": r[4] or 0,
                                                 "cache_write": r[5] or 0, "reasoning": r[6] or 0}
        for r in rows:
            n, nu = counts.get(r["id"], (0, 0))
            items.append({
                "source": "opencode", "id": "opencode:" + r["id"], "path": OPENCODE_DB, "subagents": [],
                "parent": ("opencode:" + r["parent_id"]) if r["parent_id"] else None,
                "summary": {
                    "title": r["title"], "first_prompt": first_line_text(firsts.get(r["id"]), 400), "cwd": r["directory"],
                    "branch": None, "start": r["time_created"], "end": r["time_updated"],
                    "tokens": {"input": r["tokens_input"], "output": r["tokens_output"], "cache_read": r["tokens_cache_read"],
                               "cache_write": r["tokens_cache_write"], "reasoning": r["tokens_reasoning"]},
                    "models": models.get(r["id"], {}), "cost": r["cost"], "turns": nu or 0, "messages": n,
                    "client": r["agent"], "archived": bool(r["time_archived"])}})
        c.close()
    except Exception as e:
        print("OpenCode scan failed:", e, file=sys.stderr)
    return items


def opencode_messages(sid):
    c = oc_connect()
    out = []
    msgs = c.execute("select id, data, time_created from message where session_id=? order by time_created, id", (sid,)).fetchall()
    parts = {}
    for mid, data in c.execute("select message_id, data from part where session_id=? order by time_created, id", (sid,)):
        parts.setdefault(mid, []).append(json.loads(data))
    for mid, data, tc in msgs:
        m = json.loads(data)
        role = m.get("role")
        model = m.get("modelID")
        for p in parts.get(mid, []):
            pt = p.get("type")
            ts = ((p.get("time") or {}).get("start")) or tc
            if pt == "text":
                kind = "meta" if p.get("synthetic") else "text"
                out.append({"role": role, "kind": kind, "text": p.get("text", ""), "time": ts, "model": model})
            elif pt == "reasoning" and p.get("text"):
                out.append({"role": role, "kind": "thinking", "text": p["text"], "time": ts, "model": model})
            elif pt == "tool":
                st = p.get("state") or {}
                out.append({"role": "assistant", "kind": "tool_call", "name": p.get("tool"), "id": p.get("callID"),
                            "text": clip(st.get("input")), "time": ts})
                if st.get("output") is not None or st.get("error"):
                    out.append({"role": "tool", "kind": "tool_result", "id": p.get("callID"), "error": st.get("status") == "error",
                                "text": clip(st.get("output") or st.get("error")), "time": ts})
            elif pt == "file":
                url = p.get("url") or ""
                if (p.get("mime") or "").startswith("image/") and url.startswith("data:"):
                    out.append({"role": role, "kind": "image", "image": url, "time": ts})
                else:
                    out.append({"role": role, "kind": "meta", "text": f"[file] {p.get('filename')} ({p.get('mime')})", "time": ts})
            elif pt == "patch":
                out.append({"role": "system", "kind": "meta", "text": "Patched: " + ", ".join(p.get("files") or []), "time": ts})
            elif pt == "compaction":
                out.append({"role": "system", "kind": "meta", "text": "[context compacted]", "time": ts})
        if role == "assistant" and m.get("tokens"):
            tk = m["tokens"]
            for o in reversed(out):
                if o["role"] == "assistant":
                    o["usage"] = {"input": tk.get("input", 0), "output": tk.get("output", 0), "reasoning": tk.get("reasoning", 0),
                                  "cache_read": (tk.get("cache") or {}).get("read", 0), "cache_write": (tk.get("cache") or {}).get("write", 0)}
                    break
    c.close()
    return out


# ---------------------------------------------------------------------- Index
class Index:
    def __init__(self):
        self.sessions = {}
        self.lock = threading.Lock()
        self.status = {"state": "idle", "done": 0, "total": 0, "started": None, "finished": None}
        self.cache = {}
        try:
            with open(CACHE_FILE, encoding="utf-8") as f:
                self.cache = json.load(f)
        except Exception:
            pass

    def _summarize_file(self, item):
        p = item["path"]
        try:
            st = os.stat(p)
        except OSError:
            return None
        key = f"{p}|{st.st_mtime_ns}|{st.st_size}|{PARSER_VERSION}"
        s = self.cache.get(key)
        if s is None:
            try:
                s = claude_summary(p) if item["source"] == "claude" else codex_summary(p)
            except Exception as e:
                s = {"title": f"(failed to parse: {e})", "tokens": empty_tokens(), "models": {}}
            self.cache[key] = s
        item["size"] = st.st_size
        return s

    def refresh(self):
        with self.lock:
            if self.status["state"] == "scanning":
                return
            self.status = {"state": "scanning", "done": 0, "total": 0, "started": time.time(), "finished": None}
        files = scan_claude() + scan_codex()
        oc = scan_opencode()
        self.status["total"] = len(files) + len(oc)
        new = {}

        def work(item):
            s = self._summarize_file(item)
            sub_tok = empty_tokens()
            for sub in item["subagents"]:
                ss = self._summarize_file({"source": "claude", "path": sub["path"]})
                if ss:
                    add_tokens(sub_tok, ss["tokens"])
                    sub["title"] = ss.get("title")
                    sub["tokens"] = ss["tokens"]
                    sub["models"] = ss.get("models", {})
            self.status["done"] += 1
            return item, s, sub_tok

        with ThreadPoolExecutor(max_workers=min(8, (os.cpu_count() or 4))) as ex:
            for item, s, sub_tok in ex.map(work, files):
                if s is None:
                    continue
                item["summary"] = s
                item["subagent_tokens"] = sub_tok
                new[item["id"]] = item
        names = codex_thread_names()
        for item in new.values():
            if item["source"] == "codex":
                nm = names.get(item["id"].split(":", 1)[1])
                if nm:
                    item["summary"] = {**item["summary"], "title": nm}
        for item in oc:
            item["size"] = None
            item["subagent_tokens"] = empty_tokens()
            new[item["id"]] = item
            self.status["done"] += 1
        # OpenCode child sessions -> roll their tokens into the parent for display
        for item in oc:
            par = new.get(item.get("parent") or "")
            if par:
                add_tokens(par["subagent_tokens"], item["summary"]["tokens"])
                par["subagents"].append({"id": item["id"], "title": item["summary"]["title"], "tokens": item["summary"]["tokens"]})
        live = {i["path"] for i in new.values()} | {sub["path"] for i in new.values() for sub in i["subagents"] if "path" in sub}
        self.cache = {k: v for k, v in self.cache.items() if k.rsplit("|", 3)[0] in live and k.endswith(f"|{PARSER_VERSION}")}
        try:
            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(self.cache, f)
        except Exception as e:
            print("cache write failed:", e, file=sys.stderr)
        self.sessions = new
        self.status.update(state="ready", finished=time.time())

    def listing(self):
        out = []
        for it in self.sessions.values():
            s = it.get("summary") or {}
            out.append({"id": it["id"], "source": it["source"], "path": it["path"], "size": it.get("size"),
                        "parent": it.get("parent"),
                        "subagents": [{k: v for k, v in sub.items() if k != "path"} for sub in it["subagents"]],
                        "subagent_tokens": it.get("subagent_tokens"), **s})
        return out

    def messages(self, sid):
        if sid.startswith("claude-sub:"):
            _, parent, rel = sid.split(":", 2)
            it = self.sessions.get("claude:" + parent)
            if not it:
                return None
            for sub in it["subagents"]:
                if sub["id"] == sid:
                    return claude_messages(sub["path"])
            return None
        it = self.sessions.get(sid)
        if not it:
            return None
        if it["source"] == "claude":
            return claude_messages(it["path"])
        if it["source"] == "codex":
            return codex_messages(it["path"])
        return opencode_messages(sid.split(":", 1)[1])

    def search(self, q, limit=200):
        ql = q.lower()
        hits = []
        for it in self.sessions.values():
            if it["source"] == "opencode":
                continue
            try:
                for line in read_lines(it["path"]):
                    if '"type":"api-request' in line[:120]:
                        continue
                    i = line.lower().find(ql)
                    if i >= 0:
                        hits.append({"id": it["id"], "snippet": line[max(0, i - 80): i + 120]})
                        break
            except Exception:
                pass
        if os.path.exists(OPENCODE_DB):
            try:
                c = oc_connect()
                for sid, data in c.execute("select session_id, data from part where data like ? group by session_id",
                                           (f"%{q}%",)):
                    i = data.lower().find(ql)
                    hits.append({"id": "opencode:" + sid, "snippet": data[max(0, i - 80): i + 120]})
                c.close()
            except Exception:
                pass
        return hits[:limit]


INDEX = Index()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        if not isinstance(body, (bytes, bytearray)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                return self._send(200, f.read(), "text/html")
        if u.path == "/api/status":
            return self._send(200, {**INDEX.status, "count": len(INDEX.sessions),
                                    "locations": {"claude": CLAUDE_DIR, "codex": CODEX_DIRS, "opencode": OPENCODE_DB}})
        if u.path == "/api/sessions":
            return self._send(200, INDEX.listing())
        if u.path == "/api/session":
            sid = (q.get("id") or [""])[0]
            msgs = INDEX.messages(sid)
            if msgs is None:
                return self._send(404, {"error": "not found"})
            return self._send(200, {"id": sid, "messages": msgs})
        if u.path == "/api/search":
            term = (q.get("q") or [""])[0].strip()
            if len(term) < 2:
                return self._send(200, [])
            return self._send(200, INDEX.search(term))
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if urlparse(self.path).path == "/api/refresh":
            threading.Thread(target=INDEX.refresh, daemon=True).start()
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    threading.Thread(target=INDEX.refresh, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Session Browser on http://127.0.0.1:{args.port}  (Ctrl+C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
