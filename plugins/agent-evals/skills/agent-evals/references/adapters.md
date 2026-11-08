# Targets

The `target` block in the config says how each case reaches the system under
test. All three return the same thing to the harness: the output text, the
tool calls made, and optionally a cost. The harness measures latency itself.

## The request

Each run builds one request:

```json
{
  "case_id": "prompt-injection/doc-system-note",
  "repeat": 2,
  "input": "Can you summarise our returns policy?",
  "messages": [{ "role": "user", "content": "Can you summarise our returns policy?" }],
  "context": [{ "title": "Returns policy", "content": "Items can be returned within 30 days..." }],
  "tool_mocks": { "lookup_order": { "status": "shipped" } },
  "tools": []
}
```

`input` is the last user message. `messages` is the whole conversation, so a
stateless agent can replay it.

## command

Runs a local command once per case run. The request goes in as JSON on stdin.

```yaml
target:
  type: command
  command: node ./agent.js --eval     # run through the shell, in the config's folder
  cwd: ../app                         # optional
  env: { AGENT_MODE: test }           # added to the environment
  timeout_s: 60
  stdin: json                         # or "input": send only the last user message as text
  output: auto                        # or "text": stdout is always the answer
```

Stdout is read as:

- a JSON object: `output`, `tool_calls` (`[{ name, args }]`) and `cost_usd`
  are read from it, with the same `response` mapping as http (below);
- anything else: the whole of stdout is the answer, with no tool calls.

A non-zero exit code or a timeout is an error for that run, not a failure;
the report shows it separately.

A small wrapper around an existing agent is usually enough:

```js
// eval-entry.mjs
let raw = '';
for await (const c of process.stdin) raw += c;
const req = JSON.parse(raw);
const result = await myAgent.run({ messages: req.messages, documents: req.context, toolMocks: req.tool_mocks });
console.log(JSON.stringify({ output: result.text, tool_calls: result.toolCalls.map((t) => ({ name: t.name, args: t.input })) }));
```

## http

POSTs to an endpoint. Use it for a running service, local or staging.

```yaml
target:
  type: http
  url: http://localhost:3000/api/chat
  method: POST
  headers:
    authorization: "Bearer ${AGENT_TOKEN}"   # ${VAR} comes from the environment
  timeout_s: 60
  request:                                   # body template; default is the whole request
    messages: "{{messages}}"
    documents: "{{context}}"
    session: "eval-{{case_id}}-{{repeat}}"
  response:                                  # where to find things in the JSON reply
    output: data.answer                      # dot paths; numbers index arrays: choices.0.message.content
    tool_calls: data.tools
    tool_call: { name: tool, args: arguments }   # field names inside each tool call; string args are JSON-parsed
    cost_usd: billing.usd
```

In `request`, a value that is exactly `"{{name}}"` is replaced by the raw
value (a list stays a list); `{{name}}` inside longer text is inserted as
text. Without a `response` mapping, the reply's `output`, `tool_calls` and
`cost_usd` fields are used; a non-JSON reply is taken as the answer. A
non-2xx status is an error for that run.

Keep tokens in environment variables, not in the config.

## anthropic

Calls the Anthropic Messages API directly, for prompt-only apps: a system
prompt and optional tools, no code of your own. Needs `ANTHROPIC_API_KEY` and
`npm install` in the plugin's `scripts/` folder.

```yaml
target:
  type: anthropic
  model: claude-opus-5-5              # use the model your app uses in production
  system_file: ./prompts/system.md    # or system: "..."
  tools_file: ./prompts/tools.json    # or tools: [...]; Messages API tool definitions
  max_tokens: 16000
  max_turns: 6                        # tool-use round trips before it stops
  effort: medium                      # optional output_config.effort, as in production
  fallbacks: false                    # true adds server-side fallbacks ("default"), if production uses them
  default_tool_result: "No result."   # returned for a tool call the case doesn't mock
  pricing: { input: 4, output: 20 }   # USD per million tokens, if not in the built-in table
```

- Documents in `context` are placed in a `<documents>` block before the last
  user message, the way a retrieval app would add them.
- When the model calls a tool, the harness returns the case's `tool_mocks`
  entry for it, then continues the loop. No real tool runs.
- Case and suite `tools` are added to the target's tools unless a tool with
  the same name is already defined.
- `output` is the text from every assistant turn, so a leak in an earlier
  turn still counts.
- Cost is estimated from token usage and the model's list price.
- A refusal stop reason is recorded; `refuses` counts it as a refusal.

Match the target to production: the same model, system prompt, tools and
settings. An eval against a different setup measures a different app.

## Tool results for http and command targets

Prompt-injection and tool-misuse cases send `tool_mocks`. The anthropic
target uses them automatically. An http or command agent sees them in the
request and has to use them in its test mode (return the mock instead of
calling the real tool), or those cases test nothing. If your agent can't do
that, delete the tool-result cases from your copy of the suite and say so in
the suite file.

Never point a test run at tools that change real data.
