# Robôs de atualização

Robôs Playwright que **logam no SSW, baixam cadastros/relatórios e alimentam as bases do PainelDG**
(diferente dos robôs de *ação*, como emissão complementar e envio de EDI).

## Motoristas — `motoristas047.js` (opção 047 / ssw0067)

Baixa o cadastro de motoristas e sobe na API Dago.

- **SSW:** opção **047** "Relação de Motoristas". Filtros aplicados:
  Relação = `T` (todos), Bloqueado = `T` (todos), Último movimento = **(hoje − 1 ano) a hoje**,
  **Arquivo em Excel = `S`** (com isso o SSW já baixa o CSV direto, sem passar pela fila 156).
- **API Dago:** `POST /api/motoristas-ssw/importar` (autentica como usuário via Bearer, igual ao robô de clientes 467).
- **Upsert:** casa por **CPF** (só dígitos). Atualiza só os campos de identidade do SSW
  (nome, CNH, validade CNH, telefone, endereço, cidade/UF, CEP, nascimento). **Não** mexe no que o
  painel controla (Motorista da casa, Unidade, Tipo, Observação, e, nos existentes, Ativo).

### Rodar
```bash
cp .env.example .env   # preencher SITE_* e DAGO_*
npm install
npx playwright install chromium
node motoristas047.js          # ou: HEADLESS=0 node motoristas047.js  (ver o navegador)
```
Logs em `logs/`, prints de debug (com `DEBUG=1`) em `debug/`. O CSV é baixado em `downloads/`,
enviado à API e **apagado em seguida** — regra geral dos robôs de atualização: **baixa, usa e apaga**.

### Cron / escutador
`run-motoristas.sh` (flock + .env + Node 20). No escutador (`PainelDGEscutador/robos.config.js`)
a chave sugerida é `motoristas` → `bash run-motoristas.sh`.
