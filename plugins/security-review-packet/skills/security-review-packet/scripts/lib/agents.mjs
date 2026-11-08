// Agent tools (what each one can do), agent loop settings and MCP servers.
import { CAPABILITIES, CONTROLS } from './rules.mjs';
import { isCode, isComment, ref, cap, redact } from './files.mjs';

const HITL = CONTROLS.humanApproval[0];
const HITL_LOOSE = /\b(approv\w*|confirm\w*|human[_ ]review|ask[_ ]user|await_user)\b/i;

// Each detector returns { name, framework } for a line that starts a tool.
const DETECTORS = [
  { framework: 'ai-sdk', re: /^\s*(?:["']?([\w-]+)["']?\s*:\s*|(?:export\s+)?const\s+(\w+)\s*=\s*)tool\(\s*\{/, name: (m) => m[1] || m[2] },
  { framework: 'claude-agent-sdk / mcp', re: /\btool\(\s*["']([\w-]+)["']\s*,/, name: (m) => m[1] },
  { framework: 'mcp-server', re: /\.(?:tool|registerTool)\(\s*["']([\w-]+)["']/, name: (m) => m[1] },
  { framework: 'langchain-js', re: /new\s+(?:DynamicStructuredTool|DynamicTool)\(\s*\{/, name: (m, f, i) => nameNear(f, i) },
  { framework: 'python-decorator', re: /^\s*@(?:tool|function_tool|mcp\.tool|server\.tool|app\.tool|\w+\.tool|beta_tool)\b(?:\(\s*["']?([\w -]*)["']?)?/, name: (m, f, i) => m[1]?.trim() || defName(f, i) },
  { framework: 'langchain-py', re: /(?:StructuredTool|Tool)\.from_function\(|^\s*Tool\(\s*name\s*=|FunctionTool\.from_defaults\(/, name: (m, f, i) => nameNear(f, i) || defName(f, i) },
  // Raw tool schemas for the Anthropic / OpenAI APIs.
  { framework: 'tool-schema', re: /^\s*["']?name["']?\s*:\s*["']([\w-]+)["']\s*,?\s*$/, name: (m) => m[1],
    when: (f, i) => /input_schema|inputSchema|["']?parameters["']?\s*:/.test(f.lines.slice(i, i + 10).join('\n')) && /(tools|function|input_schema|anthropic|openai)/i.test(f.lines.slice(Math.max(0, i - 6), i + 10).join('\n')) },
];

function nameNear(f, i) {
  for (let j = i; j < Math.min(f.lines.length, i + 6); j++) {
    const m = f.lines[j].match(/\bname\s*[:=]\s*["']([\w -]+)["']/);
    if (m) return m[1];
  }
  return null;
}
function defName(f, i) {
  for (let j = i; j < Math.min(f.lines.length, i + 6); j++) {
    const m = f.lines[j].match(/^\s*(?:async\s+)?def\s+(\w+)/);
    if (m) return m[1];
  }
  return null;
}

function descriptionNear(f, i) {
  for (let j = i; j < Math.min(f.lines.length, i + 8); j++) {
    const m = f.lines[j].match(/description\s*[:=]\s*["'`]([^"'`]{3,160})/) || (j > i && f.lines[j].match(/^\s*"""(.{3,160})/));
    if (m) return m[1].replace(/"""$/, '').trim();
  }
  return null;
}

// End of a tool body: next tool start, or a dedent for Python, max 80 lines.
function bodyEnd(f, start, starts) {
  const next = starts.find((s) => s > start) ?? f.lines.length;
  let end = Math.min(next, start + 80, f.lines.length);
  if (f.path.endsWith('.py')) {
    const d = f.lines.findIndex((l, j) => j > start && /^\s*(async\s+)?def\s/.test(l));
    if (d > 0) {
      const indent = f.lines[d].match(/^\s*/)[0].length;
      for (let j = d + 1; j < end; j++) {
        const l = f.lines[j];
        if (l.trim() && l.match(/^\s*/)[0].length <= indent && !/^\s*[)\]}]/.test(l)) { end = j; break; }
      }
    }
  }
  return end;
}

export function scanTools(files) {
  const tools = [];
  for (const f of files.filter(isCode)) {
    if (!/tool|function_tool|input_schema|mcp/i.test(f.text)) continue;
    const hits = [];
    f.lines.forEach((line, i) => {
      if (isComment(line) || line.length > 300) return;
      for (const d of DETECTORS) {
        const m = line.match(d.re);
        if (!m || (d.when && !d.when(f, i))) continue;
        const name = d.name(m, f, i);
        if (!name) continue;
        // Skip a raw schema that sits inside a tool() call we already caught.
        if (d.framework === 'tool-schema' && hits.some((h) => i - h.i < 4)) continue;
        hits.push({ i, name, framework: d.framework });
        break;
      }
    });
    const starts = hits.map((h) => h.i);
    for (const h of hits) {
      const end = bodyEnd(f, h.i, starts);
      const caps = {};
      let hitl = null;
      for (let j = h.i; j < end; j++) {
        const l = f.lines[j];
        if (isComment(l)) continue;
        for (const [cap, re] of Object.entries(CAPABILITIES)) if (!caps[cap] && re.test(l)) caps[cap] = ref(f, j);
        if (HITL.test(l) && hitl?.strength !== 'framework-approval') hitl = ref(f, j, { strength: 'framework-approval' });
        else if (!hitl && HITL_LOOSE.test(l)) hitl = ref(f, j, { strength: 'keyword-only' });
      }
      // Tool schema defined in one place, handler elsewhere: look for a
      // handler named after the tool in the same file.
      if (h.framework === 'tool-schema' && !Object.keys(caps).length) {
        const re = new RegExp(`(case\\s+["']${h.name}["']|["']${h.name}["']\\s*:|function\\s+${h.name.replace(/-/g, '_')}\\b|def\\s+${h.name.replace(/-/g, '_')}\\b)`);
        const hj = f.lines.findIndex((l, j) => j !== h.i && re.test(l));
        if (hj >= 0) {
          for (let j = hj; j < Math.min(f.lines.length, hj + 40); j++) {
            for (const [cap, r] of Object.entries(CAPABILITIES)) if (!caps[cap] && r.test(f.lines[j])) caps[cap] = ref(f, j);
            if (!hitl && (HITL.test(f.lines[j]) || HITL_LOOSE.test(f.lines[j]))) hitl = ref(f, j, { strength: HITL.test(f.lines[j]) ? 'framework-approval' : 'keyword-only' });
          }
        }
      }
      tools.push({ name: h.name, framework: h.framework, file: f.path, line: h.i + 1, description: descriptionNear(f, h.i), capabilities: caps, humanApproval: hitl, test: f.test || undefined });
    }
  }
  return tools;
}

// Apps that ask the model for a JSON plan ("call get_x with these params")
// and dispatch it themselves: a string-union type of tool names, with a
// handler map or switch somewhere in the repo.
export function scanCustomRouters(files, known) {
  const tools = [];
  const code = files.filter(isCode);
  for (const f of code) {
    f.lines.forEach((line, i) => {
      const m = line.match(/^\s*(?:export\s+)?type\s+(\w*Tool\w*)\s*=\s*(.*)$/);
      if (!m) return;
      let text = m[2];
      for (let j = i + 1; j < Math.min(f.lines.length, i + 60) && !/;\s*$/.test(text); j++) text += f.lines[j];
      const names = [...text.matchAll(/['"]([a-z][\w-]{2,})['"]/g)].map((x) => x[1]);
      if (names.length < 2) return;
      for (const name of names) {
        if (known.some((t) => t.name === name)) continue;
        const re = new RegExp(`(case\\s+['"]${name}['"]|^\\s*['"]?${name}['"]?\\s*:\\s*(async\\b|\\(|function))`);
        let handler = null;
        for (const g of code) { const k = g.lines.findIndex((l) => re.test(l)); if (k >= 0) { handler = { f: g, i: k }; break; } }
        const caps = {};
        let hitl = null;
        if (handler) {
          for (let j = handler.i; j < Math.min(handler.f.lines.length, handler.i + 40); j++) {
            const l = handler.f.lines[j];
            if (j > handler.i && /^\s*['"]?[a-z][\w-]+['"]?\s*:\s*(async\b|\()/.test(l) || (j > handler.i && /^\s*case\s/.test(l))) break;
            for (const [cap, r] of Object.entries(CAPABILITIES)) if (!caps[cap] && r.test(l)) caps[cap] = ref(handler.f, j);
            if (!hitl && HITL.test(l)) hitl = ref(handler.f, j, { strength: 'framework-approval' });
          }
        }
        tools.push({ name, framework: `custom router (type ${m[1]})`, file: f.path, line: i + 1, handler: handler ? `${handler.f.path}:${handler.i + 1}` : null, description: null, capabilities: caps, humanApproval: hitl, test: f.test || undefined });
      }
    });
  }
  return tools;
}

// Tools that run on the model provider's side (web search, code execution).
const HOSTED = /\{\s*(?:type\s*:\s*)?['"]?(web_search\w*|google_search\w*|googleSearch|code_execution\w*|code_interpreter|file_search|computer_use\w*|computer_\d+|bash_\d+|text_editor_\w+|web_fetch\w*|url_context|mcp)['"]?\s*[:,}]/;
export function scanHostedTools(files) {
  const refs = [];
  for (const f of files.filter(isCode)) f.lines.forEach((l, i) => { const m = !isComment(l) && l.length < 300 && l.match(HOSTED); if (m) refs.push(ref(f, i, { tool: m[1] })); });
  return cap(refs, 20);
}

const AGENT_CONFIG = /\b(allowedTools|allowed_tools|disallowedTools|disallowed_tools|permissionMode|permission_mode|bypassPermissions|dangerously\w*|maxTurns|max_turns|maxSteps|max_steps|stopWhen|stepCountIs|max_iterations|recursion_limit|toolChoice|tool_choice|parallel_tool_calls|canUseTool|can_use_tool)\b/;

export function scanAgentConfig(files) {
  const refs = [];
  for (const f of files.filter(isCode)) f.lines.forEach((l, i) => { if (!isComment(l) && l.length < 300 && AGENT_CONFIG.test(l)) refs.push(ref(f, i, { setting: l.match(AGENT_CONFIG)[1] })); });
  return cap(refs, 30);
}

const MCP_FILE = /(^|\/)(\.mcp\.json|mcp\.json|mcp_config\.json|claude_desktop_config\.json|\.claude\/settings(\.local)?\.json|\.cursor\/mcp\.json|\.vscode\/mcp\.json|\.gemini\/settings\.json|\.windsurf\/mcp_config\.json)$/;
const MCP_CODE = /\b(StdioClientTransport|SSEClientTransport|StreamableHTTPClientTransport|MultiServerMCPClient|MCPServerStdio|MCPServerSse|MCPServerStreamableHttp|experimental_createMCPClient|createMCPClient|mcp_servers\s*=|mcpServers\s*:|new McpServer\(|McpServer\(|FastMCP\(|createSdkMcpServer|stdio_client\(|streamablehttp_client\(|sse_client\()/;

function redactArg(a) {
  const s = redact(String(a));
  return /^[A-Za-z0-9+/_-]{24,}$/.test(s) ? '[redacted]' : s.replace(/(:\/\/[^:/@\s]+:)[^@\s]+@/, '$1[redacted]@');
}

export function scanMcp(files) {
  const configs = [];
  for (const f of files) {
    if (!MCP_FILE.test(f.path)) continue;
    let json;
    try { json = JSON.parse(f.text.replace(/^\s*\/\/.*$/gm, '')); } catch { continue; }
    const servers = json.mcpServers || json.servers || json.mcp?.servers || {};
    for (const [name, s] of Object.entries(servers)) {
      const line = f.lines.findIndex((l) => l.includes(`"${name}"`));
      configs.push({
        name, file: f.path, line: line + 1,
        transport: s.type || (s.url || s.serverUrl ? 'http/sse' : 'stdio'),
        command: s.command ? redactArg(s.command) : undefined,
        args: Array.isArray(s.args) ? s.args.map(redactArg) : undefined,
        url: s.url || s.serverUrl ? redactArg(s.url || s.serverUrl).replace(/\?.*$/, '?…') : undefined,
        envNames: s.env ? Object.keys(s.env) : [],
        headerNames: s.headers ? Object.keys(s.headers) : [],
        pinnedVersion: Array.isArray(s.args) ? s.args.some((a) => /@\d+\.\d+/.test(a)) : undefined,
      });
    }
  }
  const code = [];
  for (const f of files.filter(isCode)) f.lines.forEach((l, i) => {
    if (isComment(l) || l.length > 300) return;
    const m = l.match(MCP_CODE);
    if (m) code.push(ref(f, i, { role: /Client|client|Transport|mcp_servers|mcpServers|MCPServer(Stdio|Sse|Streamable)/.test(m[1]) ? 'client' : 'server', api: m[1] }));
  });
  return { configs, code: cap(code, 20) };
}
