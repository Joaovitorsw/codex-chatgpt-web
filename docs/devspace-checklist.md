# Checklist das reclamações — integração DevSpace / ChatGPT Web / Codex

Atualizado em 25/10/2026. A lista canônica de acompanhamento é `devspace-checklist` no work_state do projeto. Este documento é sua versão legível.

## Como acompanhar este trabalho

- Em cada continuação desta tarefa, consultar a lista persistente, identificar o que falta e trabalhar na próxima pendência concreta.
- Atualizar o status e a evidência após cada avanço; registrar novas reclamações sem apagar as anteriores.
- Priorizar funcionamento real. Testes unitários, rótulos de progresso e eventos simulados não comprovam a experiência na interface.
- Marcar um item como concluído somente quando sua condição de aceitação tiver evidência correspondente. Distinguir chamada direta, fluxo pelo bridge e apresentação visual.
- Não executar novamente comandos ou edições já feitos pelo modelo Web apenas para produzir cards no Codex.
- Não declarar o objetivo inteiro concluído enquanto houver itens obrigatórios pendentes.

## Pendências obrigatórias

- [x] **1. Cards dos comandos executados pelo modelo Web.** Rodadas A/B após reinício mostraram shell expandido com comando/saída/Success e estado Running com tempo avançando. Execuções reais terminaram com códigos 0 e 7. Evidências em `outputs/devspace-final-cards-20261025/`.
- [x] **2. Quantidade e identificação dos arquivos editados pelo modelo Web.** Duas operações nativas geraram três entradas de alteração em dois caminhos distintos. A interface exibiu **Edited 2 files**, com os caminhos e alterações; a releitura confirmou os conteúdos finais sem repetir edições. Evidência: `outputs/devspace-multifile-live-20261025/audit.json` e `native-ui.json`. O relatório original conserva a falha de shell e a recuperação está registrada separadamente.
- [x] **3. Caixas dinâmicas de leitura, edição e gravação.** Fluxo nativo comprovado: shell em execução/finalizado, PowerShell e caminhos, patches Created/Edited, resultados associados à mesma chamada. Leitura por shell aparece como shell, sem inventar uma ferramenta de leitura separada.
- [x] **4. Registro e descoberta completos das ferramentas DevSpace.** Gateway OAuth direto usa esquemas nativos reais para shell, patch, MCP e agentes. Não depende mais de bootstrap JSON por shell nem workspaceId legado. Rodadas integradas após reinício confirmadas no mesmo chat.
- [x] **5. Criar subagentes a partir do modelo Web.** A cadeia real pelo relay criou um subagente nativo, com modelo/cwd/protocolo herdados e resultado real. Evidência: `outputs/devspace-web-subagents-20261025-codex/report.json` e stdout nativo. O teste completo permanece falho por outros critérios, registrados no item 6.
- [x] **6. Acompanhar e gerenciar os subagentes.** O fluxo Web/DevSpace/relay comprovou spawn, wait e close; a retomada comprovou resume_agent, send_input, wait e close do mesmo ID, sem substituto e preservando o histórico anterior. Modelo/cwd herdados foram validados na primeira cadeia. Evidências: `outputs/devspace-web-subagents-20261025-native-route/audit.json` e `outputs/devspace-agent-continuation-20261025/audit.json`. A leitura nova de arquivo tem limite de prova separado do ciclo de agentes.
- [x] **7. Nova mensagem durante uma execução.** A preferência ativa da interface ainda estava em Queue, mesmo com steer salvo no arquivo. Foi alterada em Settings para Steer. Um novo envio comum por Enter durante a geração chegou sem fila e concluiu o mesmo turno com `UI_DEFAULT_STEER_OK_20261025`. Evidência nativa: `outputs/devspace-native-followup-20261025/audit.json`.
- [x] **8. Direcionamento durante a execução — fluxo real no código atual.** A chamada turn/steer interrompeu a resposta anterior, gerou novo envio e concluiu com o marcador pedido. Evidência: `outputs/devspace-live-steering-20261025-durable/audit.json`. Isso não comprova automaticamente todos os modos de envio nem a ausência de regressões na interface do usuário.
- [x] **9. Contadores e informações exibidas.** Dois patches exibem um arquivo distinto; leituras não contam como edição. Ícones de agente/MCP e 180 amostras HTTP/navegador durante sobreposição real conferidos; serviço voltou a 0/0 após conclusão. Prova anterior da tela Limites preservada.
- [x] **10. Continuidade e sincronização.** Corrigida consulta global de comentários/atividades: leitura limitada ao turno vinculado. Rodadas A/B concluídas sem o comentário antigo, com workspace e associações preservados. Auditoria: `outputs/devspace-final-cards-20261025/audit.json`.
- [x] **11. Reiniciar para carregar as correções acumuladas.** Reinício seguro realizado com o serviço ocioso; instância de substituição respondeu saudável e aceitando chamadas. Registro: `work/safe-restart/latest.log`, 25/10/2026 às 03:36. O estado de saúde deve ser consultado novamente quando necessário.
- [x] **12. Validação real da integração após o reinício.** Rodadas A/B/C no mesmo chat confirmaram shell, leitura, criação/atualização, MCP, agentes, contadores, skills e continuidade. Envio/direcionamento têm prova real anterior preservada. A expansão visual final da falha fica explicitamente no item 14.
- [x] **13. Compatibilidade do provedor steering_live.** Configuração atual preservada e chats de validação retomados; não substituir identidades de chats nem forçar escritores concorrentes.
- [x] **14. Conferência final de atividades e ícones.** Observados shell Running/Success, criação/edição, MCP write/read e agente criado/iniciado/finalizado/encerrado. Após o usuário liberar a janela, a falha existente foi expandida: Shell, comando exato, saída FINAL_EXPECTED_FAILURE e Exit code 7 conferidos visualmente e pela acessibilidade. Evidência: `outputs/devspace-final-cards-20261025/command-failed-exit7.jpg`. Nenhum comando repetido para fabricar card. Falha de transporte anterior à execução é erro MCP, sem inventar comando executado.
- [x] **15. Rodada integrada de regras, skills, MCP, memória e agentes.** Leituras de AGENTS/base/skill, MCP write/read, spawn/wait/close e dois patches em um caminho comprovados nos eventos nativos e no disco.
- [x] **16. Skills de frontend e persistência.** Contrato reforçado para consultar skills do usuário, aplicar impeccable/frontend-visual-qa nas tarefas pertinentes e reler checklist antes de concluir. Rodada C leu impeccable 4.7 e referências, executou context e verificou achado no código; rodada B releu work_state após concluir as operações.

## Ordem de prioridade atual

### Atualização de execução — 25/10 às 06:06

**Verificação posterior:** uma resposta real no mesmo chat, após o reinício, recuperou exatamente o marcador anterior de direcionamento e terminou com 80 linhas e um único resultado final, sem ferramentas ou edições. Foram observados HTTP/navegador 0/0 → 1/1 → 1/0 → 0/0. O coletor original terminou aos 90 registros antes de ambos zerarem; esse limite foi preservado, e três leituras posteriores confirmam repouso. Evidência: `outputs/devspace-launcher-ui-20261025/active-context-audit.json`. Os contadores de comandos/arquivos/agentes continuam pendentes.

A rota pública 443 exclusiva do DevSpace foi desligada/religada uma vez, com restauração em finally e comparação posterior idêntica ao snapshot inicial. O acesso externo continuou falhando. A sessão Windows não é elevada e a ACL do serviço não permite parada pelo usuário atual. A próxima tentativa de recuperação — reiniciar o serviço existente do Tailscale — exige uma sessão administrativa do usuário, e não é uma correção comprovada. Evidência: `outputs/devspace-connector-refresh-20261025/funnel-cycle-audit.json`. Não alterar proteções de rede para contornar a falha. O objetivo inteiro permanece incompleto.

**Avanço às 06:30:** reinício seguro carregou as correções no bridge PID77024, versão 6.1.13, com zero turnos HTTP/navegador ativos. A interface do launcher mostrou ausência de tarefa ativa, eventos reais de início/fim e a tela Limites. O histórico exibiu 170 mensagens, igual aos 170 registros locais; todos são de outros modelos, coerente com zero nos três contadores Pro. Atualizar voltou habilitado sem erro. Evidência: `outputs/devspace-launcher-ui-20261025/audit.json`. Isso fecha a conferência do estado local observado, mas não os contadores de comandos/arquivos/agentes em execução nem a recuperação visual de um timeout.

A checagem pública agora considera IPv4/IPv6, usa Cloudflare como alternativa ao Google e conserva diagnóstico limitado de curl/HTTP/TCP/TLS. A execução real em pwsh e Windows PowerShell falhou corretamente com quatro timeouts antes de estabelecer TCP. O netmap contém 23 peers de entrada e uma regra de ingresso; a rota usa Ethernet, sem proxy WinHTTP. Não foi identificada a causa entre relays e filtragem, e nenhuma proteção de rede foi alterada. Evidência: `outputs/devspace-connector-refresh-20261025/network-audit.json`.

**Correção posterior, às 06:18:** a saúde HTTPS anterior usava MagicDNS, que nesta máquina resolve o domínio para `100.96.187.81`. Isso não comprovava entrada pública. O DNS público anuncia dois relays; ambos deram timeout TCP 443 no teste desta máquina. A atualização de ferramentas do Codex Native2 falhou duas vezes com mensagem terminal, mesmo com endereço correto, OAuth conectado e **Permitir tudo**. Nenhuma chamada correspondente chegou ao DevSpace. A causa entre indisponibilidade dos relays e filtragem de rede ainda não foi determinada.

O helper agora consulta DNS público e verifica HTTPS diretamente nos endereços anunciados, preservando hostname/SNI e validação TLS. Sua execução real passou a falhar explicitamente neste estado, em vez de declarar saúde pública pela rota interna. Referência do contrato DNS: [Google Public DNS JSON API](https://developers.google.com/speed/public-dns/docs/doh/json). Evidência: `outputs/devspace-connector-refresh-20261025/audit.json`. O atalho de configurações do launcher foi atualizado para a rota observada `https://chatgpt.com/settings/plugins-settings`. Não houve nova execução de efeitos pelo conector nem mudança de conta/permissões.

Os itens 2 e 7 acima agora refletem as provas reais posteriores: dois arquivos distintos e envio comum por Enter com Steer ativo. As notas cronológicas abaixo preservam o estado anterior de cada tentativa.

O Tailscale havia entrado em NoState. Após iniciar seu cliente de sessão existente, o backend voltou a Running e a configuração preexistente do Funnel reapareceu sem troca de conta ou preferências. A inicialização agora verifica identidade, encaminhamento e saúde pública; usa PORT/config.port e verifica processo proprietário e saúde local. Não encerra uma instância existente apenas porque ela não atende à porta esperada. Falhas da integração geram aviso no launcher normal; o modo DevSpaceOnly continua falhando explicitamente.

A repetição real pela interface terminou antes do comando: open_workspace retornou erro interno. Uma leitura direta pelo conector também retornou MCP -32603, enquanto a saúde pública continuava válida; os logs locais não registraram a chamada MCP correspondente. Evidência: `outputs/devspace-native-command-retry-20261025/report.json`. A reconexão do conector e a transição visual do card continuam pendentes. Os três scripts PowerShell passam na análise sintática e o caminho DevSpaceOnly reutilizou o serviço saudável existente.

1. Cards de comandos e contagem/lista de arquivos editados (itens 1–3 e 9).
2. Criação e gerenciamento de subagentes pelo conector (itens 5–6).
3. Nova mensagem comum, continuidade e verificação final integrada (itens 7, 10 e 12).

O objetivo permanece aberto. As provas parciais existentes não encerram as pendências acima.

## Avanço em andamento — cards nativos

Foi adicionada a entrada CLI `tool-relay`, que reutiliza o servidor MCP nativo já existente para inventário, descoberta e chamada de ferramentas. O prompt informa essa rota ao conector DevSpace quando existe um comando local válido. A operação deve ser encaminhada antes de sua execução, preservando as aprovações do Codex; não há replay de operações feitas diretamente no DevSpace.

A checagem de tipos passou. A validação real em `outputs/devspace-live-tool-relay-20261025/report.json` comprovou uma execução nativa de `Get-Location`, com eventos `commandExecution` de início e conclusão, saída, diretório e exit code 0. Os itens 1–3 permanecem abertos até a apresentação visual e as alterações de arquivos serem comprovadas; um evento nativo não substitui essa inspeção.

O teste real de alteração de arquivo (`outputs/devspace-live-file-relay-20261025-retry/report.json`) não passou: o modelo respeitou a restrição do `bash` do DevSpace contra despacho de alterações. Nenhum patch foi aplicado e nenhum evento `fileChange` foi criado. A documentação instalada do DevSpace 1.0.8 oferece `DEVSPACE_TOOL_MODE=codex` (`apply_patch`, `exec_command`, `write_stdin`) como superfície alternativa experimental. Esse modo ainda não foi ativado no serviço compartilhado nem no contrato cacheado do conector. Não contabilizar arquivos ou declarar o item 2 resolvido antes de corrigir essa fronteira.

O modo `codex` foi validado localmente com os handlers reais do DevSpace instalado, através de MCP em memória (não por uma chamada do ChatGPT): `outputs/devspace-codex-contract-20261025/report.json`. Foram comprovados registro das cinco ferramentas, patch real em um arquivo de diagnóstico com metadados de caminho/contagem, leitura, execução e polling de processo. O shell do DevSpace no Windows exigiu PowerShell explícito e UTF-8 para preservar o caminho acentuado. O launcher agora aceita `-DevSpaceToolMode codex` e `-DevSpaceOnly`; processos existentes continuam sendo preservados.

Na interface do ChatGPT, o Codex Native2 já consta como **Permitir tudo** e oferece **Atualizar ferramentas**. A ativação compartilhada foi adiada porque a espera de três minutos não encontrou janela ociosa (1 HTTP/1 browser); nenhum processo foi parado. A permissão do plugin não é a causa da restrição do antigo bash. Falta ativar o modo, atualizar o catálogo e repetir o fluxo Web/Codex.

## Recuperação de chats — 25/10 às 04:15

- [x] **13. Retomar chats salvos com `steering_live`.** O diagnóstico havia persistido um provedor definido apenas no processo temporário. Foi salvo backup do config.toml e adicionada compatibilidade com o bridge permanente em localhost:17841. A validação real `thread/resume` do app-server instalado retomou o chat `01a171e4-99e5-7821-bb54-c765eca1a713` sem gerar nova resposta. O diagnóstico futuro usa o provedor estável `openai`.

Atualização do item 4: após autorização explícita, DevSpace foi reiniciado solicitando modo codex (PID58108), e a atualização das ferramentas foi acionada. Porém a conversa Web nova ainda recebeu o contrato antigo de bash e não produziu fileChange. A ativação efetiva/cache continua pendente; as notas anteriores de espera são históricas.

## Evidência real após atualização do catálogo — 25/10 às 04:32

O conector atualizado chamou `exec_command` do modo codex. A cadeia Web → DevSpace → tool-relay → apply_patch nativo concluiu em `outputs/devspace-live-file-relay-20261025-refreshed-v2/report.json`: exatamente um item nativo `fileChange` concluído, uma inclusão, caminho absoluto e diff com `LIVE_NATIVE_FILE_RELAY_OK`. O arquivo foi lido e confirmado. Itens 1–3 continuam abertos para apresentação visual e cobertura das demais ações; o evento não é prova visual do contador.

O HTTP 400 observado na atualização era a sondagem `server/discover`, seguida de fallback bem-sucedido para initialize/tools/list (HTTP 200), conforme a documentação oficial do SDK MCP. Não era falha de permissão. O servidor temporário de diagnóstico foi encerrado; o DevSpace oficial voltou pelo launcher em modo codex e respondeu saudável.

O prompt agora distingue os modos do DevSpace e orienta a descoberta/despacho de comandos, inspeção, alterações e agentes pelo relay nativo quando disponíveis. Também foram corrigidos dois problemas de informação no launcher: sucesso antigo do catálogo mascarando falha recente e leitura de limites sem prazo que paralisava o polling. As checagens estáticas passaram; essas duas mudanças ainda precisam de validação de execução no launcher atualizado.

## Agentes, novas mensagens e reinício — 25/10 às 04:41

O teste Web criou um subagente nativo, coletou seu resultado com wait e o encerrou com close_agent. O teste completo `outputs/devspace-web-subagents-20261025-codex/report.json` falhou porque os comandos de pai/filho passaram diretamente pelo DevSpace, sem os eventos nativos esperados, e faltou um checkpoint de navegação do filho. A orientação principal foi corrigida para remover a escolha conflitante de execução direta. Uma nova execução real está registrada em `outputs/devspace-web-subagents-20261025-native-route`.

A preferência desktop `followUpQueueMode` estava em queue enquanto o estado inicial já indicava steer. Foi criado backup e salvo steer no config.toml; o Codex instalado leu a configuração sem erro. A documentação oficial de Settings confirma a distinção entre direcionar a execução atual e aguardar a próxima. Isso ainda não comprova o envio comum pela interface.

O reinício seguro terminou às 04:40:58 com bridge PID74612 versão6.1.13 saudável. Ele carregou a rota principal atualizada e as correções de indicadores do launcher. DevSpace oficial permaneceu saudável em modo codex (listener PID41552 na última inspeção). Nenhum processo temporário de diagnóstico continua servindo DevSpace.

## Auditoria final desta rodada — 25/10 às 04:50

A execução `outputs/devspace-web-subagents-20261025-native-route` concluiu com exit0. Seu report original foi preservado com a falha do verificador antigo de navegação. A auditoria `audit.json` revalidou os eventos/rollouts reais e a página do filho já preparada: status passed, comandos de pai/filho sobrepostos, duas chamadas de shell em cada lado, nenhum call_id duplicado, exatamente um efeito do filho, resultados e encerramento nativos válidos. A medição de sobreposição agora exclui consultas de inventário; conta somente execução/polling de shell.

O item 6 continua aberto para continuar/retomar um agente; a criação, coleta e encerramento já têm prova real. Também continuam pendentes a conferência visual dos cards/contadores, o envio comum pela interface e a continuidade integrada. O serviço terminou saudável e sem turnos ativos. Não declarar a integração inteira pronta com base apenas nesta auditoria.

## Conferência nativa e retomada — 25/10 às 05:08

O Codex nativo exibiu o card **Edited proof.txt**, os valores **+1 / -0**, a aba **Changes**, a árvore com o caminho correto e a linha `LIVE_NATIVE_FILE_RELAY_OK`. O resumo de trabalho do chat de comando exibiu o controle nativo **Ran Get-Location**. Evidência preservada em `outputs/devspace-native-ui-20261025.json`. A expansão da saída do comando não concluiu por referência de elemento expirada; não tratar isso como saída visual comprovada. O caso de arquivo único está comprovado; faltam múltiplos arquivos e reedições para fechar a contagem distinta.

A retomada do mesmo agente passou no ciclo nativo resume_agent → send_input → wait → close_agent, sem criar substituto e preservando o histórico anterior como prefixo exato. Evidência: `outputs/devspace-agent-continuation-20261025/audit.json`, `native-lifecycle.json` e `tool-dispatch.json`. Houve corrupção real U+FFFD no caminho do prompt de diagnóstico; o relatório foi preservado e o script passou a obter o caminho real de process.cwd. A leitura nova do arquivo não tem prova independente, mas o ciclo de agentes e o marcador novo têm.

O envio comum pela interface permanece pendente: o rascunho de diagnóstico ficou no campo, a chamada não chegou ao backend e os contadores continuaram 0/0. O rascunho foi removido. Não confundir limite da automação nativa com falha comprovada do bridge. A janela original do launcher recebeu o foco de volta após a inspeção.

## Inicializacao silenciosa e recuperacao de servicos — 25/10
O script silencioso reutiliza launcher/bridge saudaveis e executa a integracao DevSpace/Tailscale. Inicia o servico Tailscale parado, reconecta estado Stopped com preferencias salvas, recupera Funnel ausente e reinicia um processo DevSpace identificado que falhou no healthcheck. Falhas de inicializacao ficam em work/devspace/startup.log. Launcher/bridge com falha usam o worker existente de reinicio; ele aguarda turnos ativos quando ha resposta e recupera apos tres falhas consecutivas de saude. Sintaxe dos scripts e diff verificados. Execucao real -DevSpaceOnly reutilizou DevSpace saudavel e verificou ingresso publico. Ramos destrutivos de recuperacao nao foram exercitados derrubando servicos saudaveis; cards e conectividade MCP completa seguem pendentes.

## Gateway nativo direto e detalhes de atividade — 25/10, 13:49
O endpoint /mcp agora preserva o OAuth e a identidade de recurso do DevSpace 1.0.8 e encaminha o MCP estruturado ao servidor nativo existente, sem transportar JSON por comandos shell. O script silencioso usa modo native por padrao. Catalogo Native2 atualizado pela interface real; endpoint publico e chamada autenticada comprovados. Requisicao sem credencial retorna401. Sessao cancelada libera o rastreio; sessoes ociosas expiram e os processos sao encerrados. Revisao independente de protocolo/lifecycle aplicada.

No mesmo chat de validacao, houve comando nativo12s concluido0 e falha intencional separada com codigo7/saida associados. Outro turno criou2arquivos, reeditou1 e exibiu Edited2files na interface. As tres entradas de alteracao correspondem a2caminhos; as leituras nao aumentaram a contagem. Houve uma leitura adicional de diagnostico naquele turno: preservada no relatorio, sem omitir ou confundir com uma edicao.

O gateway agora envia a descricao real separadamente do nome functions.exec usado no despacho: consulta de catalogo, patch/caminhos, leitura/caminhos/PowerShell e acompanhamento da sessao(write_stdin). Testes reais confirmaram os novos textos, uma leitura12s/exit0 e patch+leitura com falha intencional7. Os nomes e argumentos de execucao permanecem intactos; nao ha replay para fabricar cards. Evidencias: outputs/devspace-native-gateway-acceptance-20261025/audit.json, progress-details.json e counter-native-ui.jpg.

Ainda ha comentario antigo reaparecendo no inicio de algumas continuacoes, apesar de as operacoes finais corresponderem ao pedido atual. Essa observacao fica na pendencia de continuidade; nao declarar toda a integracao concluida por causa dos testes de cards.

## Recuperacao da base de conhecimento — 25/10
Restaurados 16 documentos ausentes do ZIP codex-skills-conhecimento-mcps-2026-10-15.zip em C:/Users/jovipds/.codex/knowledge. Hashes conferidos com o arquivo antes da atualizacao de politica. AGENTS.md atual, configuracao, credenciais MCP e skills existentes preservados. A politica antiga de navegador foi arquivada e reconciliada com a regra atual Browser Bridge only; indice atualizado.
Manifesto: outputs/knowledge-recovery-20261025/restored-files.json. Nao estavam no backup: research-and-reference-guidelines.md, parallel-agent-guidelines.md, godot-guidelines.md, game-asset-production-guidelines.md e game-animation-preview-guidelines.md. Esses documentos nao foram declarados recuperados.
Rodada integrada enviada ao mesmo chat de teste: leitura real de regras/skill, inventario, MCP work_state, um subagente, criacao/atualizacao/leitura de um arquivo e encerramento do filho. Aguardar e auditar resultados antes de fechar item15.
A rodada integrada concluiu funcionalmente: turno01a17417-d655-75f0-9cd4-b4219684fb74, MCPwork_state_write/read com marcador conferido independentemente; filho01a17418-85d7-73b1-b057-47e6bfe8bc51 leu pacote6.1.13/skill e foi aguardado/encerrado. Dois patches nativos, um caminho, conteudo final INTEGRATED_V2 e comando exit0. Eventos nativos de shell/MCP/arquivo/agente auditados em outputs/knowledge-recovery-20261025/integrated-audit.json. Paridade visual integral dos icones e comentario antigo repetido continuam pendentes.

## Fechamento funcional e verificacao visual — 25/10, 14:44
Causa do comentario antigo: livePublicCommentaryText consultava todos os paineis da pagina quando qualquer Stop estava visivel. A leitura agora usa a identidade do turno atual e falha fechada durante remontagem; atividades vinculadas receberam o mesmo limite. Rodadas A/B/C concluidas sem o comentario antigo, com contexto e resultados associados.
A rodada B comprovou cinco comandos (incluindo leitura45s/exit0 e falha intencional7), dois patches/um caminho, MCP e um filho concluido/encerrado. A interface mostrou shell em execucao, shell expandido com Success/saida, icones MCP/agente/edicao e um arquivo distinto. 180 amostras de atividade preservadas, incluindo sobreposicao de pai/filho; depois o runtime voltou a0/0. A rodada C encontrou as skills globais, leu impeccable4.7+referencias, executou setup e produziu um achado estatico real.
Evidencias: outputs/devspace-final-cards-20261025/audit.json, skill-discovery-audit.json, activity-samples.json e cinco capturas nativas. As capturas nao demonstram todos os estados possiveis de toda ferramenta; a matriz cobre os tipos exercitados. Falta apenas a expansao visual final da falha7: a chamada e a linha nativa ja existem, mas houve bloqueio de entrada simultanea na janela. Nao executar novamente a falha para fabricar outro card.
Typecheck e diff--check passaram. Reinicio seguro14:41 carregou as ultimas instrucoes; bridgePID33116 saudavel, ultimo estadoocioso0/0.

## Checklist concluido — 25/10
A pendencia visual do item14 foi resolvida apos o usuario informar que a janela estava livre. O card EXISTENTE da falha foi expandido e mostrou Shell, Write-Output FINAL_EXPECTED_FAILURE; exit7, a saida e Exit code7. Provas: command-failed-exit7.jpg e command-failed-accessibility.txt no diretorio final de evidencias. Nao houve nova execucao. Todos os16itens da lista canonica estao concluidos para os cenarios descritos; notas anteriores de pendencia neste historico sao superadas por esta verificacao final.
