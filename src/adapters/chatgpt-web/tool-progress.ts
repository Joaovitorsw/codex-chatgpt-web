const FILE_ACTIONS = new Map([["read", "Lendo"], ["edit", "Editando"], ["write", "Gravando"]]);
const LABEL_LIMIT = 200;

function boundedLabel(value: string, limit = LABEL_LIMIT): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function progressPath(path: string): string {
  if (path.length <= 110) return path;
  const parts = path.split(/[\\/]/);
  const filename = parts.at(-1) ?? path;
  const separator = path.includes("\\") ? "\\" : "/";
  const tail = parts.slice(-2).join(separator);
  if (tail.length <= 100) return `${parts[0]}${separator}…${separator}${tail}`;
  const visibleName = filename.length > 150 ? `${filename.slice(0, 99)}…${filename.slice(-50)}` : filename;
  return `…${separator}${visibleName}`;
}

function progressFiles(paths: string[]): string {
  const unique = [...new Set(paths)];
  if (unique.length === 1) return `“${progressPath(unique[0]!)}”`;
  const names = unique.map(path => path.split(/[\\/]/).at(-1) || path);
  return `${unique.length} arquivos: ${progressNames(names)}`;
}

function progressNames(names: string[], limit = 110): string {
  const visible = names.slice(0, 3);
  const remaining = names.length - visible.length;
  const suffix = remaining ? ` (+${remaining})` : "";
  const nameLimit = Math.floor((limit - suffix.length - (visible.length - 1) * 2) / visible.length);
  return visible.map(name => boundedLabel(name, nameLimit)).join(", ") + suffix;
}

function skillProgress(paths: string[]): string | undefined {
  const unique = [...new Set(paths)];
  const skills = unique.filter(path => /(?:^|[\\/])SKILL\.md$/i.test(path));
  if (!skills.length) return undefined;
  const skillPaths = new Set(skills);
  const others = unique.filter(path => !skillPaths.has(path));
  const names = skills.map(path => path.split(/[\\/]/).at(-2) || "SKILL.md");
  const suffix = others.length
    ? ` e ${others.length === 1 ? "arquivo" : "arquivos"} ${progressNames(others.map(path => path.split(/[\\/]/).at(-1) || path), 65)}`
    : "";
  return `Lendo ${skills.length === 1 ? "skill" : "skills"} ${progressNames(names, others.length ? 85 : 155)}${suffix}`;
}

function commandProgress(leaf: string, command: string, args: Record<string, unknown>): string {
    const shell = typeof args.shell === "string" ? args.shell : "";
    const powershell = /powershell|pwsh/i.test(shell) || /\b(?:Get-Content|Write-Output|Start-Sleep|Get-Location)\b|\$ErrorActionPreference/.test(command);
    const shellName = powershell ? "PowerShell" : /bash/i.test(shell) || leaf === "bash" ? "Bash" : "shell";
    const paths = [...command.matchAll(/(?:^|[;\r\n|&])\s*Get-Content\s+(?:-(?:LiteralPath|Path)\s+)?(?:'([^'\r\n]*)'|"([^"\r\n]*)"|([^\s;|&'"`]+))/gi)]
      .map(match => match[1] ?? match[2] ?? match[3]!)
      .filter(path => !/[$*?]/.test(path) && !path.startsWith("-"));
    const skill = skillProgress(paths);
    if (skill) return boundedLabel(`${skill} no ${shellName}`);
    return paths.length
      ? boundedLabel(`Lendo ${progressFiles(paths)} no ${shellName}`)
      : `Executando no ${shellName}`;
}

function patchProgress(patch: unknown): string | undefined {
  if (typeof patch !== "string") return undefined;
  const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1]!.trim());
  return paths.length ? boundedLabel(`Aplicando patch em ${progressFiles(paths)}`) : undefined;
}

/** Describe the requested operation, even when Codex dispatches it through its exec gateway. */
export function chatGptToolProgressLabel(
  wireName: string,
  payload?: { arguments?: Record<string, unknown>; input?: string },
): string {
  const leaf = wireName.split(/__|\./).at(-1) ?? wireName;
  const args = payload?.arguments ?? {};
  const path = typeof args.path === "string" ? args.path : args.file_path;
  const command = typeof args.cmd === "string" ? args.cmd : args.command;
  if ((leaf === "exec_command" || leaf === "shell_command" || leaf === "bash") && typeof command === "string") return commandProgress(leaf, command, args);
  if (leaf === "apply_patch" && payload) {
    return patchProgress(payload.input ?? args.input ?? args.patch) ?? "Aplicando alterações nos arquivos";
  }
  if (leaf === "codex_tool_inventory" && payload) {
    const query = typeof args.query === "string" ? `: ${boundedLabel(args.query, 100)}` : "";
    return `Consultando ferramentas nativas${query}`;
  }
  const action = FILE_ACTIONS.get(leaf);
  if (action && typeof path === "string") {
    if (leaf === "read") {
      const skill = skillProgress([path]);
      if (skill) return boundedLabel(skill);
    }
    return boundedLabel(`${action} ${progressFiles([path])}`);
  }
  if (leaf === "write_stdin" && payload) {
    const session = typeof args.session_id === "number" || typeof args.session_id === "string" ? `, sessão ${boundedLabel(String(args.session_id), 64)}` : "";
    return `Acompanhando processo nativo${session}`;
  }
  return boundedLabel(baseToolLabel(leaf, wireName));
}

/** Presentation only; the native error code remains authoritative for lifecycle handling. */
export function chatGptFailureLabel(code: string): string | undefined {
  switch (code) {
    case "codex_tool_timeout": return "Tempo limite de transporte";
    case "client_cancelled": return "Execução interrompida";
    case "chatgpt_tool_approval_required": return "Aprovação pendente";
    default: return undefined;
  }
}

function baseToolLabel(leaf: string, wireName: string): string {
  switch (leaf) {
    case "work_state_read": return "Lendo estado do trabalho";
    case "work_state_write": return "Salvando estado do trabalho";
    case "work_state_list": return "Listando estados do trabalho";
    case "work_state_delete": return "Removendo estado do trabalho";
    case "list_tools": return "Listando ferramentas disponíveis";
    case "get_tool_schema": return "Consultando parâmetros da ferramenta";
    case "open_workspace": return "Abrindo workspace local";
    case "read": return "Lendo arquivo local";
    case "edit": return "Editando arquivo local";
    case "write": return "Gravando arquivo local";
    case "bash": return "Executando comando no workspace";
    case "exec_command":
    case "shell_command": return "Executando comando local";
    case "exec": return "Executando código nativo";
    case "write_stdin": return "Acompanhando processo local em execução";
    case "apply_patch": return "Aplicando alterações nos arquivos";
    case "view_image": return "Verificando imagem local";
    case "spawn_agent": return "Criando subagente";
    case "wait_agent": return "Acompanhando subagente";
    case "wait": return wireName.includes("multi_agent") ? "Acompanhando subagente" : "Aguardando execução";
    case "close_agent": return "Encerrando subagente";
    case "send_input":
    case "resume_agent": return "Enviando instruções ao subagente";
    case "tool_search":
    case "codex_tool_inventory": return "Localizando a ferramenta necessária";
    default: {
      const parts = wireName.replace(/^mcp__/, "").split(/__|\./).filter(Boolean);
      const operation = leaf.replaceAll("_", " ");
      const provider = parts.slice(0, -1).join(" / ").replaceAll("_", " ");
      return provider ? `Executando ${boundedLabel(operation, 110)} (${boundedLabel(provider, 65)})` : `Executando ${operation}`;
    }
  }
}
