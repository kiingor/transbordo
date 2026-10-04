# Softcom Transbordo

Portal independente do Signal para uma equipe gerenciar vários números WhatsApp na Evolution.
O repositório e o banco são próprios. Não há acesso direto ao banco do Signal.

## O que está implementado

- Login por pessoa, perfis administrador e operador e revogação de sessões.
- Novas instâncias Evolution por QR Code ou vinculação de uma instância existente com sua chave.
- Uma conexão da plataforma com um único canal no Signal; vários dispositivos sob essa conexão.
- Transbordo individual por dispositivo, inicialmente pausado.
- Nome de usuário, foto e número sincronizados da Evolution; fotos servidas somente a usuários autenticados.
- Sincronização de contatos, busca, paginação e exclusões individuais, preservadas nas sincronizações.
- Recebimento autenticado, fila persistente, deduplicação e tentativas de entrega ao Signal.
- Retorno das respostas por uma API compatível com Evolution, com uma chave da plataforma e roteamento pelo dispositivo de origem.
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
| `TRUST_PROXY` | IPs/CIDRs dos proxies, separados por vírgula. Em Swarm, use a sub-rede do proxy; não confie em redes de clientes. |
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

1. No painel **Dispositivos**, abra **Conexão da plataforma** e copie URL, identificador e chave (administrador).
2. No Signal, crie **um único canal Evolution API**, marque **Conexão externa**, escolha a unidade e use esses três campos.
3. Copie o webhook completo gerado pelo Signal e salve em **Webhook único do Signal** no portal.
4. Adicione dispositivos e clique em **Conectar WhatsApp**. Para uma instância existente, essa ação substitui seu webhook atual pelo portal; para uma nova, provisiona e apresenta o QR Code.
5. Confira nome, foto e número em **Dispositivo e perfil**, sincronize contatos, configure exceções e ative o transbordo de cada aparelho.

```text
Vários dispositivos Evolution → Portal → Um canal no Signal
Dispositivo de origem         ← Portal ← Resposta do Signal
```

O Signal usa `provider=evolution`, `externalConnection=true`, `externalPlatform=true` e
provisionamento `existing`. A URL é `/platform`; a instância configurada no Signal é o UUID
da plataforma. O webhook leva esse UUID e `device.id`. O Signal conserva o dispositivo nas
referências de conversa, mensagem e mídia e o envia na URL ao responder. A chave global nunca
é uma chave administrativa da Evolution: o portal traduz cada operação para a instância correta.

Todos os dispositivos usam o mesmo canal, inclusive os adicionados depois. O catálogo autenticado
`/platform/devices` permite ao Signal exibir os nomes, números e fotos. Perfis são atualizados a
cada cinco minutos e também no pareamento ou pelo botão **Sincronizar perfil**. A chave só aparece
para administradores; operadores podem controlar transbordo e contatos.

O Signal não reinicia nem exclui dispositivos externos. QR e pareamento pertencem ao portal.
O portal permite apenas operações necessárias ao transporte. Envios sem dispositivo são recusados;
o envio de teste do Signal oferece uma seleção explícita do aparelho.

### Atualização de uma instalação anterior

Faça backup consistente do SQLite e preserve a chave de cifragem. A migração para schema 2 é
transacional e preserva usuários, dispositivos, contatos, exclusões e fila. Gera uma identidade e
chave globais estáveis. Bridges individuais antigos continuam compatíveis até a configuração do
webhook global. Para migrar, pause os dispositivos, configure o único canal da plataforma e então
reative os aparelhos desejados. Alterar o webhook exige todos pausados e descarta pendências do
destino anterior, sem replay. Canais antigos do Signal não são removidos automaticamente.

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

Verifique os serviços, portas e proxy existentes na VPS antes de instalar. Reutilize a Evolution já instalada;
se ausente, instale-a em uma stack independente conforme a documentação oficial.

### Docker Compose

1. Copie o projeto para uma pasta própria, por exemplo `/opt/softcom-transbordo`.
2. Prepare `.env` fora do Git com a chave de cifragem, URLs HTTPS, credenciais Evolution e usuário de bootstrap.
3. Rode `docker compose -f deploy/compose.yml build`.
4. Rode `docker compose -f deploy/compose.yml run --rm portal node dist/server/bootstrap.js`.
5. Remova `BOOTSTRAP_PASSWORD` do `.env` e execute `docker compose -f deploy/compose.yml up -d`.
6. Configure o proxy existente para `127.0.0.1:3080`. `deploy/Caddyfile.example` é um exemplo de TLS automático.
7. Valide `/health`, login, QR, contato ignorado, transbordo pausado e resposta de texto/mídia antes de ativar números reais.

### Docker Swarm com Traefik

Use `deploy/stack.swarm.yml` quando o servidor já possui Swarm e Traefik. O manifesto reutiliza
a rede e o resolvedor TLS existentes e não publica uma porta extra no host.

1. Construa a imagem no nó de execução e identifique-a pelo commit, por exemplo `docker build -t softcom-transbordo:<commit> .`.
2. Crie `/opt/softcom-transbordo/data`, proprietário UID/GID `1000:1000`, modo `0700`.
3. Crie os secrets externos `softcom_transbordo_encryption_v1` (chave de cifragem base64) e
   `softcom_transbordo_evolution_v1` (chave global Evolution), lendo arquivos protegidos ou stdin.
   Não coloque os valores na linha de comando, no manifesto ou no Git. Guarde a chave de cifragem para backup.
4. Exporte `PORTAL_IMAGE`, `PORTAL_DOMAIN`, `EVOLUTION_URL`, `SIGNAL_API_ORIGIN`, `PORTAL_NODE`,
   `PROXY_NETWORK`, `PROXY_CIDR` e `TLS_RESOLVER`. `PORTAL_DOMAIN` contém somente o domínio, sem `https://`.
   Aponte o DNS para a VPS antes da publicação. A imagem local exige que `PORTAL_NODE` seja o nó onde ela foi construída.
5. Aplique `docker stack deploy --resolve-image never -c deploy/stack.swarm.yml softcom-transbordo`.
6. Execute `node dist/server/bootstrap.js` em um container com os mesmos secrets e volume,
   passando `BOOTSTRAP_EMAIL` e `BOOTSTRAP_PASSWORD` por ambiente protegido. Não recrie o banco nem os secrets em atualizações.
7. Confira uma réplica saudável, HTTPS, login e `/health`. Conecte os números explicitamente pelo portal.

O aplicativo lê `ENCRYPTION_KEY_FILE` e `EVOLUTION_API_KEY_FILE` em `/run/secrets` no Swarm;
esses arquivos têm prioridade sobre os valores de ambiente correspondentes.

Execute **uma réplica** do portal por banco SQLite/volume. Faça backup consistente do banco com
`node:sqlite.backup` ou com o serviço parado; não copie apenas o arquivo principal enquanto WAL está ativo.
Guarde `ENCRYPTION_KEY` separadamente junto à política de backup: sem ela, as credenciais e a fila não podem ser recuperadas.
Logs do proxy devem omitir ou mascarar o segredo presente nas URLs `/hooks/` e `/webhooks/`.

## Referências do contrato

O contrato segue o cliente Evolution existente no Signal e os endpoints oficiais da Evolution:
[rotas de chat](https://github.com/EvolutionAPI/evolution-api/blob/main/src/api/routes/chat.router.ts)
e [controlador de contatos](https://github.com/EvolutionAPI/evolution-api/blob/main/src/api/controllers/chat.controller.ts).
`src/provider-url.ts` foi adaptado do Signal para manter resolução DNS fixada, limites de corpo e bloqueio de SSRF sem dependência entre repositórios.
