export function hasNativeConnectorInternalFailure(answer: string): boolean {
  const normalized = answer.normalize("NFD").replaceAll(/[\u0300-\u036f]/g, "").toLowerCase();
  const excludedOutcome = /\b(approval|denied|cancelled|canceled|cancellation|timeout|timed out|aprovacao|negada|cancelad[ao]|tempo limite)\b/;
  const prose = normalized
    .replaceAll(/```[^]*?```/g, "")
    .replaceAll(/`[^`\n]*`/g, "")
    .replaceAll(/"[^"\n]*"|“[^”\n]*”|'[^'\n]*'/g, "")
    .split("\n")
    .filter(line => !line.trimStart().startsWith(">"))
    .join("\n");
  const recovered = /\b(fixed|resolved|recovered|tests passed|all tests pass|corrigi|corrigido|resolvido|testes passaram)\b/;
  const recoveryProse = prose.replaceAll(/\b(not|never|nao)\s+(?:yet\s+)?(?:fixed|resolved|recovered|corrigido|resolvido)\b/g, "");
  if (excludedOutcome.test(prose) || recovered.test(recoveryProse)) return false;
  const statements = (prose.match(/[^.!?\n]+[.!?]?/g) ?? [])
    .filter(statement => !statement.endsWith("?"));
  const hypothetical = /\b(if|whether|example|means|explanation|se|exemplo|significa|explicacao)\b/;
  const assertions = statements.filter(statement => !hypothetical.test(statement));
  const assertedProse = assertions.join(" ");

  const englishFailure = assertions.some(statement =>
    /\btool failed internally\b/.test(statement)
    && /\b(codex|plugin|native|local connector|execution context)\b/.test(statement));
  const portugueseFailure = assertions.some(statement =>
    /\b(ferramentas?|executor|codex native\d*|native2)\b/.test(statement)
    && /\b(falhou internamente|erros? internos?|falhas? internas?)\b/.test(statement)
    && !/\bnao (falhou|retornou|retornaram)\b/.test(statement));
  const nativeFailure = assertions.some(statement =>
    /\b(codex native\d*|native2)\b/.test(statement)
    && /\binternal errors?\b/.test(statement)
    && !/\b(did not|never)\b/.test(statement));
  const unableToWork = /\b(nao foi possivel|nao consegui|nao pude|nao posso|could not|unable to)\b/.test(assertedProse)
    && /\b(executar|ler|consultar|realizar|rodar|confirmar|run|read|inspect)\b/.test(assertedProse)
    && /\b(comandos?|arquivos?|navegador|testes?|projeto|execucao|commands?|files?|tests?)\b/.test(assertedProse);
  const noChanges = /\bnenhuma (alteracao|correcao) foi aplicada\b/.test(assertedProse);
  return englishFailure || ((portugueseFailure || nativeFailure) && (unableToWork || noChanges));
}
