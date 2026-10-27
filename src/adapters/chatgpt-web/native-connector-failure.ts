export function hasNativeConnectorInternalFailure(answer: string): boolean {
  const normalized = answer.normalize("NFD").replaceAll(/[\u0300-\u036f]/g, "").toLowerCase();
  const excludedOutcome = /\b(approval|denied|cancelled|canceled|cancellation|timeout|timed out|aprovacao|negada|cancelad[ao]|tempo limite)\b/;
  const recovered = /\b(fixed|resolved|recovered|tests passed|all tests pass|corrigi|corrigido|resolvido|testes passaram)\b/;
  if (excludedOutcome.test(normalized) || recovered.test(normalized)) return false;

  const prose = normalized
    .replaceAll(/```[^]*?```/g, "")
    .replaceAll(/`[^`\n]*`/g, "")
    .replaceAll(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'/g, "")
    .split("\n")
    .filter(line => !line.trimStart().startsWith(">"))
    .join("\n");
  const statements = prose.split(/[.!?\n]+/);
  if (prose.includes("?")) return false;
  const hypothetical = /\b(if|whether|example|means|explanation|se|exemplo|significa|explicacao)\b/;
  if (hypothetical.test(prose)) return false;

  const englishFailure = statements.some(statement =>
    /\btool failed internally\b/.test(statement)
    && /\b(codex|plugin|native|local connector|execution context)\b/.test(statement));
  const portugueseFailure = statements.some(statement =>
    /\b(ferramentas?|executor)\b/.test(statement)
    && /\b(falhou internamente|erros? internos?)\b/.test(statement)
    && !/\bnao falhou\b/.test(statement));
  const unableToWork = /\b(nao foi possivel|nao consegui|nao pude)\b/.test(prose)
    && /\b(executar|ler|consultar|realizar|rodar|confirmar)\b/.test(prose)
    && /\b(comandos?|arquivos?|navegador|testes?|projeto)\b/.test(prose);
  return englishFailure || (portugueseFailure && unableToWork);
}
