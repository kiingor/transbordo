# Softcom Transbordo

Portal independente do Signal para uma equipe gerenciar vários números WhatsApp na Evolution.
O repositório e o banco são próprios. Não há acesso direto ao banco do Signal.

## O que está implementado

- Login por pessoa, perfis administrador e operador e revogação de sessões.
- Novas instâncias Evolution por QR Code ou vinculação de uma instância existente com sua chave.
- Transbordo individual por número, inicialmente pausado.
- Sincronização de contatos, busca, paginação e exclusões individuais, preservadas nas sincronizações.
- Recebimento autenticado, fila persistente, deduplicação e tentativas de entrega ao Signal.
- Retorno das respostas por uma API compatível com Evolution, com chave exclusiva por conexão.
- Histórico de entregas e alterações, sem exibir conteúdo de mensagens ou chaves.

## Executar localmente

Requisitos: Node.js 24 ou superior e npm. SQLite faz parte do Node; nenhum banco externo é necessário.

```sh
npm ci
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Copie a chave gerada para `ENCRYPTION_KEY` no `.env`. Configure:

| Variável | Conteúdo |
| --- | --- |
| `PUBLIC_URL` | Origem do portal. Localmente: `http://localhost:3080`. |
| `EVOLUTION_URL` | URL base da Evolution 2.x. |
| `EVOLUTION_API_KEY` | Chave global, usada somente para provisionar novas instâncias. |
| `SIGNAL_API_ORIGIN` | Origem da **API** do Signal, sem caminho, distinta do painel. |
| `BOOTSTRAP_EMAIL`, `BOOTSTRAP_PASSWORD` | Primeiro administrador; senha com pelo menos 12 caracteres. |

```sh
npm run bootstrap
npm run build
npm start
```

Abra `http://localhost:3080`. Depois do bootstrap, remova a senha de bootstrap do `.env`.
O bootstrap não sobrescreve usuários existentes. Novas pessoas são cadastradas na tela Equipe.
Sem Evolution/Signal configurados, o login e o painel funcionam; o cadastro de números informa a configuração faltante.

Para desenvolvimento com provedores simulados no loopback, use `ALLOW_PRIVATE_NETWORKS=true`
e `NODE_ENV=development` ou `test`. Em produção, o portal exige HTTPS e bloqueia destinos privados.
Uma Evolution remota não alcança o `localhost` do Mac: o QR/webhook real exige uma URL pública acessível.

## Vincular ao Signal

1. Adicione um número no portal. Copie a URL da conexão, instância e chave mostrada uma única vez.
2. Clique em **Conectar WhatsApp**. Para instâncias existentes, essa ação substitui o webhook atual pelo portal. Para novas, provisiona a instância e apresenta o QR Code.
3. No Signal, crie um canal **Evolution API**, marque **Conexão externa** e use os três campos do portal.
4. Copie o webhook completo gerado pelo Signal e salve no portal.
5. Sincronize os contatos, configure as exceções e ative o transbordo.

```text
Evolution ── webhook autenticado ──> Portal ── fila durável ──> Signal
Evolution <── envio da resposta ─── Portal <── API Evolution ─ Signal
```

O Signal continua usando `provider=evolution`; a flag pública é `externalConnection=true`
e o provisionamento é `existing`. Sua URL Evolution aponta para `/bridge/:connectionId`.
O Signal não reinicia nem exclui remotamente uma conexão externa. QR e pareamento pertencem ao portal.
O portal permite apenas operações necessárias ao transporte e bloqueia administração remota pelo bridge.

## Regras de encaminhamento

- Pausado: reconhece o webhook, registra apenas metadados e descarta o conteúdo. Nunca cria uma fila para reenviar quando reativado.
- Ao pausar: cancela entregas pendentes. Uma requisição que já saiu pode terminar; o histórico registra seu resultado real. Falhas dessa requisição não voltam à fila depois da pausa.
- Mensagens com timestamp anterior à última ativação são descartadas, inclusive histórico reenviado pela Evolution.
- Contato ignorado: bloqueia entrada e respostas. A opção vale apenas para aquele número conectado.
- Identidades `@lid` são ligadas aos números quando a Evolution fornece o identificador alternativo. Com exclusões configuradas, uma identidade LID sem correspondência é descartada com motivo explícito para não contornar a exclusão.
- Grupos e status/broadcasts não são encaminhados. Eventos de contatos e conexão atualizam o portal mesmo durante a pausa.
- Falhas de rede, HTTP 429 e 5xx do Signal têm até 12 tentativas com espera crescente. Eventos expiram em 24 horas. Falhas permanentes ficam visíveis e não são repetidas automaticamente.
- O modelo é `at-least-once`: o Signal também deduplica por ID de mensagem. Metadados de deduplicação permanecem por 30 dias.
- Perda de resposta após envio à Evolution retorna HTTP 424 (`DELIVERY_UNKNOWN`). O cliente do Signal deve conter a alteração que classifica esse resultado como **ambíguo**, sem retry automático.
- Segredos e conteúdo em fila são cifrados com AES-256-GCM. Conteúdo é apagado após entrega, descarte ou falha terminal; auditoria permanece por 90 dias.

## Testes

```sh
npm run check
npm run test:browser
```

O teste de navegador usa Chrome instalado; defina `PLAYWRIGHT_CHANNEL=chromium` após
`npx playwright install chromium` se necessário. Os provedores são simulados e os dados ficam em memória.
Capturas podem ser gravadas fora do repositório com `PORTAL_SCREENSHOTS=/tmp/portal-preview`.
A homologação com QR real, mensagens/mídias reais e a versão instalada na VPS é uma etapa posterior.

## Instalar na VPS

A instalação não foi executada nesta sessão: o trabalho ficou local a pedido do usuário.
Verifique os serviços, portas e proxy existentes na VPS antes de instalar. Reutilize a Evolution já instalada;
se ausente, instale-a em uma stack independente conforme a documentação oficial.

1. Copie o projeto para uma pasta própria, por exemplo `/opt/softcom-transbordo`.
2. Prepare `.env` fora do Git com a chave de cifragem, URLs HTTPS, credenciais Evolution e usuário de bootstrap.
3. Rode `docker compose -f deploy/compose.yml build`.
4. Rode `docker compose -f deploy/compose.yml run --rm portal node dist/server/bootstrap.js`.
5. Remova `BOOTSTRAP_PASSWORD` do `.env` e execute `docker compose -f deploy/compose.yml up -d`.
6. Configure o proxy existente para `127.0.0.1:3080`. `deploy/Caddyfile.example` é um exemplo de TLS automático.
7. Valide `/health`, login, QR, contato ignorado, transbordo pausado e resposta de texto/mídia antes de ativar números reais.

Execute **uma réplica** do portal por banco SQLite/volume. Faça backup consistente do banco com
`node:sqlite.backup` ou com o serviço parado; não copie apenas o arquivo principal enquanto WAL está ativo.
Guarde `ENCRYPTION_KEY` separadamente junto à política de backup: sem ela, as credenciais e a fila não podem ser recuperadas.
Logs do proxy devem omitir ou mascarar o segredo presente nas URLs `/hooks/` e `/webhooks/`.

## Referências do contrato

O contrato segue o cliente Evolution existente no Signal e os endpoints oficiais da Evolution:
[rotas de chat](https://github.com/EvolutionAPI/evolution-api/blob/main/src/api/routes/chat.router.ts)
e [controlador de contatos](https://github.com/EvolutionAPI/evolution-api/blob/main/src/api/controllers/chat.controller.ts).
`src/provider-url.ts` foi adaptado do Signal para manter resolução DNS fixada, limites de corpo e bloqueio de SSRF sem dependência entre repositórios.
