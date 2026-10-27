const PREFIX = '[chatgpt-web-mcp] transport=';
const EVENTS = new Set(['call_received', 'reply_sent', 'reply_send_failed', 'transport_closed', 'uncorrelated_call']);
const TOOLS = new Set(['codex_exec', 'codex_tool_inventory', 'codex_tool_call', 'codex_tool_search',
  'codex_browser_read', 'codex_apply_patch', 'codex_write_stdin', 'codex_view_image',
  'codex_generate_image_asset', 'codex_turn_start', 'codex_turn_complete', 'unknown']);

export function createNativeMcpDiagnosticSink(write) {
  let buffer = '';
  let dropping = false;
  return chunk => {
    for (const fragment of String(chunk).split(/(?<=\n)/)) {
      if (!dropping) buffer += fragment;
      if (buffer.length > 65_536) { buffer = ''; dropping = true; }
      if (!fragment.endsWith('\n')) continue;
      const line = buffer.trimEnd();
      buffer = '';
      if (dropping) { dropping = false; continue; }
      if (!line.startsWith(PREFIX)) continue;
      try {
        const value = JSON.parse(line.slice(PREFIX.length));
        if (!value || !EVENTS.has(value.event)) continue;
        const event = { event: value.event };
        if (TOOLS.has(value.tool)) event.tool = value.tool;
        for (const key of ['pid', 'call', 'elapsed_ms', 'tracked_calls']) {
          if (Number.isSafeInteger(value[key]) && value[key] >= 0) event[key] = value[key];
        }
        if (value.outcome === 'result' || value.outcome === 'protocol_error') event.outcome = value.outcome;
        if (typeof value.is_error === 'boolean') event.is_error = value.is_error;
        write(event);
      } catch { /* Diagnostics never change transport delivery. */ }
    }
  };
}
