import { expect, test } from 'bun:test';
import { createNativeMcpDiagnosticSink } from '../scripts/lib/native-mcp-diagnostics.mjs';

test('native gateway retains bounded MCP lifecycle diagnostics without private content', () => {
  const events = [];
  const sink = createNativeMcpDiagnosticSink(event => events.push(event));
  const record = '[chatgpt-web-mcp] transport=' + JSON.stringify({
    event: 'reply_sent', tool: 'codex_tool_inventory', pid: 1234, call: 3, elapsed_ms: 10,
    outcome: 'result', is_error: true, arguments: 'private command', content: 'private token',
  });
  sink(record.slice(0, 25));
  expect(events).toHaveLength(0);
  sink(record.slice(25) + '\nprivate stderr\n');
  expect(events).toEqual([{
    event: 'reply_sent', tool: 'codex_tool_inventory', pid: 1234, call: 3, elapsed_ms: 10,
    outcome: 'result', is_error: true,
  }]);
  sink('[chatgpt-web-mcp] transport={invalid}\n');
  sink('x'.repeat(70_000));
  sink(record + '\n');
  expect(events).toHaveLength(1);
  sink(record + '\n');
  expect(events).toHaveLength(2);
  expect(JSON.stringify(events)).not.toContain('private');
});

test('native diagnostics cannot fail transport and reject unrecognized metadata', () => {
  const events = [];
  const sink = createNativeMcpDiagnosticSink(event => { events.push(event); throw new Error('sink'); });
  expect(() => sink('[chatgpt-web-mcp] transport={"event":"reply_sent","tool":"private value","content":"secret"}\n')).not.toThrow();
  expect(events).toEqual([{ event: 'reply_sent' }]);
});
