// Token estimates for sessions whose tool didn't record usage (Cursor, older Grok sessions).
// Text is counted with OpenAI's o200k tokenizer, a fair stand-in for other models' tokenizers.
//
// Agents send the whole conversation again on every model call, so each call is billed for the
// context so far: the new part as input and the repeated part as cache reads, as other tools report it.
// Where the transcript marks each model response (Cursor: one line each), those are the calls. Otherwise
// a new call starts when the assistant speaks after a user message, a tool result, or (where the
// transcript leaves out tool results, as Cursor's does) after its own tool calls. Back-to-back tool
// calls are one call making them in parallel.
// When the context outgrows the model's window, agents summarize it and carry on; that is modelled as
// the context dropping to a short summary, which the next call sends fresh.
// Only what the transcript holds is counted: system prompts, tool definitions and (for Cursor) tool
// output aren't recorded, so real usage is higher.
import { Tiktoken } from 'js-tiktoken/lite';
import type { Msg, Tokens } from './types';

/** Context size at which agents compact, and the summary size they continue from */
const WINDOW = 200_000;
const SUMMARY = 10_000;

let enc: Promise<Tiktoken> | null = null;

function encoder() {
	return (enc ??= import('js-tiktoken/ranks/o200k_base').then((m) => new Tiktoken(m.default)));
}

/** Long runs of the same text (minified files, base64) are slow to encode and add little: sample them. */
const CHUNK = 20_000;
function count(e: Tiktoken, text: string): number {
	if (!text) return 0;
	if (text.length <= CHUNK) return e.encode(text, [], []).length;
	// encode the start and end exactly, and scale the middle by their ratio
	const head = text.slice(0, CHUNK / 2);
	const tail = text.slice(-CHUNK / 2);
	const n = e.encode(head, [], []).length + e.encode(tail, [], []).length;
	return Math.round((n * text.length) / CHUNK);
}

export async function estimateTokens(msgs: Msg[]): Promise<Tokens> {
	const e = await encoder();
	const t: Tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 };
	let ctx = 0; // tokens in the conversation so far
	let cached = 0; // how much of it the previous call already sent
	let prev: Msg | null = null;
	const marked = msgs.some((m) => m.call);
	for (const m of msgs) {
		const n = count(e, m.text ?? '') + (m.name ? 4 : 0);
		if (m.role === 'assistant') {
			const newCall = marked ? !!m.call : !prev || prev.role !== 'assistant' || (prev.kind === 'tool_call' && m.kind !== 'tool_call');
			if (newCall) {
				t.input += ctx - cached;
				t.cache_read += cached;
				cached = ctx;
			}
			t.output += n;
			if (m.kind === 'thinking') t.reasoning += n;
		}
		ctx += n;
		if (ctx > WINDOW) {
			ctx = SUMMARY;
			cached = 0;
		}
		prev = m;
	}
	return t;
}
