// motoristas047.js — Robô de ATUALIZAÇÃO: cadastro de motoristas do SSW (opção 047 / ssw0067).
//
// Fluxo: login SSW -> opção 047 -> preenche
//   Relação = T (todos), Bloqueado = T (todos),
//   Arquivo em Excel = S -> clica ► (com Excel=S o SSW já baixa o CSV direto, sem fila 156)
//   Duas passadas (o SSW não tem "OU" entre os filtros):
//     1) Último movimento = (hoje - 1 ano) até hoje  -> quem roda
//     2) Período de cadastramento = (hoje - DIAS_CADASTRO) até hoje, movimento vazio
//        -> recém-cadastrados que ainda não têm movimento (a 1ª passada não pega)
//   -> junta os dois CSVs e sobe UMA vez na API Dago (POST /api/motoristas-ssw/importar).
//   Se a 2ª passada falhar (ex.: ninguém cadastrado no período), segue só com a 1ª.
//
// Vars no .env (ver .env.example):
//   SITE_DOMINIO, SITE_CPF, SITE_USER, SITE_PASS  (login SSW)
//   DAGO_API_BASE, DAGO_EMAIL, DAGO_SENHA         (API Dago)
//   HEADLESS=1 (0 p/ ver o navegador), SLOWMO, DEBUG=1 (prints em debug/)
//   DIAS_CADASTRO=30 (janela da 2ª passada)
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const fs = require("fs");
const { chromium } = require("playwright");
const { subirMotoristasSsw } = require("./dagoApi");

// ================= LOG =================
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function nowLog() {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

const LOG_FILE = path.join(LOG_DIR, `motoristas047_${new Date().toISOString().slice(0, 10)}.log`);
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function writeLog(level, args) {
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2))).join(" ");
  logStream.write(`[${nowLog()}] [${level}] ${msg}\n`);
}

const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => { writeLog("INFO", args); originalLog(...args); };
console.error = (...args) => { writeLog("ERROR", args); originalError(...args); };

process.on("uncaughtException", (err) => { writeLog("FATAL", [err?.stack || err]); originalError(err); process.exit(1); });
process.on("unhandledRejection", (err) => { writeLog("FATAL", [err?.stack || err]); originalError(err); process.exit(1); });

// ================= DEBUG =================
const DEBUG = String(process.env.DEBUG ?? "").trim() === "1";
const DEBUG_DIR = path.join(process.cwd(), "debug");
if (DEBUG && !fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

async function debugScreenshot(page, filename) {
  if (!DEBUG) return;
  const out = path.join(DEBUG_DIR, filename);
  await page.screenshot({ path: out, fullPage: true }).catch(() => {});
  console.log("📸 print salvo:", out);
}

// ================= DATAS (fuso Brasil; servidor roda em UTC) =================
function ddMMyy(parts) {
  return `${parts.day}${parts.month}${parts.year}`;
}
function partesBR(date) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).formatToParts(date);
  const g = (t) => p.find((x) => x.type === t).value;
  return { day: g("day"), month: g("month"), year: g("year") };
}
function hojeBR() {
  return ddMMyy(partesBR(new Date()));
}
function diasAtrasBR(dias) {
  return ddMMyy(partesBR(new Date(Date.now() - dias * 24 * 60 * 60 * 1000)));
}
function umAnoAtrasBR() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return ddMMyy(partesBR(d));
}

// ================= HELPERS SSW (frames imprevisíveis) =================
const LOGIN_URL = "https://tms.ssw.inf.br/bin/ssw0422";
const MENU_URL = "https://tms.ssw.inf.br/bin/menu01";
const DIAS_CADASTRO = Number(process.env.DIAS_CADASTRO || 30);

async function scopeWithSelector(page, selector, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const fr of page.frames()) {
      try {
        if ((await fr.locator(selector).count()) > 0) return fr;
      } catch {}
    }
    await page.waitForTimeout(200);
  }
  return null;
}

async function waitForNewPageWithSelector(context, selector, timeoutMs = 45000, ignorar = null) {
  const existing = ignorar ?? new Set(context.pages());
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      if (existing.has(p)) continue;
      await p.waitForLoadState("domcontentloaded").catch(() => {});
      for (const fr of p.frames()) {
        const count = await fr.locator(selector).count().catch(() => 0);
        if (count > 0) return p;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// Download que pode disparar na própria página ou numa aba nova que abre e fecha.
function capturarDownload(context, paginaPrincipal, timeoutMs, acionar) {
  return new Promise((resolve, reject) => {
    let terminado = false;
    const finalizar = (fn, arg) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(timer);
      context.off("page", onPage);
      for (const p of context.pages()) p.off("download", onDownload);
      fn(arg);
    };
    const onDownload = (download) => finalizar(resolve, download);
    const onPage = (novaPagina) => novaPagina.on("download", onDownload);
    const timer = setTimeout(
      () => finalizar(reject, new Error(`Timeout de ${timeoutMs}ms esperando o download.`)),
      timeoutMs
    );
    for (const p of context.pages()) p.on("download", onDownload);
    paginaPrincipal.on("download", onDownload);
    context.on("page", onPage);
    Promise.resolve().then(acionar).catch((e) => finalizar(reject, e));
  });
}

async function fill(page, sel, val) {
  const scope = await scopeWithSelector(page, sel, 30000);
  if (!scope) throw new Error(`Campo não encontrado em nenhum frame: ${sel}`);
  const loc = scope.locator(sel).first();
  await loc.waitFor({ state: "visible", timeout: 30000 });
  await loc.click({ clickCount: 3 });
  await loc.fill(String(val));
  const v = await loc.inputValue().catch(() => "");
  console.log(`   ✍️  ${sel} =`, JSON.stringify(v));
  if (v !== String(val)) throw new Error(`Campo ${sel} não aceitou o valor ${val} (ficou ${JSON.stringify(v)}).`);
}

async function typeOption(page, value) {
  const selector = 'input[name="f3"]';
  const menuFrame = await scopeWithSelector(page, selector, 30000);
  if (!menuFrame) throw new Error("Campo Opção (f3) não encontrado.");
  const opcao = menuFrame.locator(selector).first();
  await opcao.waitFor({ state: "visible", timeout: 30000 });
  await opcao.click({ force: true }).catch(() => {});
  await opcao.fill(value).catch(() => {});
  const v = await opcao.inputValue().catch(() => "");
  if (v !== value) throw new Error(`Não consegui preencher ${value} no campo Opção (f3). Valor: ${JSON.stringify(v)}`);
  await opcao.press("Tab").catch(() => {});
}

function validarArquivoExcel(file) {
  const stat = fs.statSync(file);
  if (stat.size < 500) throw new Error(`Arquivo baixado muito pequeno (${stat.size} bytes): ${file}`);
  const head = fs.readFileSync(file, "latin1").split(/\r?\n/).slice(0, 5).join("\n");
  if (!/CPF/i.test(head) || !head.includes(";")) {
    throw new Error(`Arquivo não parece o Excel do 047 (sem cabeçalho CPF com ';'): ${file}. "Arquivo em Excel = S" foi aplicado?`);
  }
}

async function runOnce() {
  const DOMINIO = process.env.SITE_DOMINIO ?? "";
  const CPF = process.env.SITE_CPF ?? "";
  const USER = process.env.SITE_USER ?? "";
  const PASS = process.env.SITE_PASS ?? "";
  if (!DOMINIO || !CPF || !USER || !PASS) {
    throw new Error("Variáveis SITE_DOMINIO/SITE_CPF/SITE_USER/SITE_PASS não carregadas (confira o .env).");
  }

  const HEADLESS = String(process.env.HEADLESS ?? "1").trim() === "1";
  const SLOWMO = Number(process.env.SLOWMO ?? (HEADLESS ? 0 : 600));
  const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOWMO });
  let outPath = null;   // arquivo que sobe (juntado, ou só o da passada 1)
  const arquivos = [];  // CSVs baixados em cada passada (temporários)

  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1366, height: 768 },
    });
    const page = await context.newPage();

    console.log("1) Abrindo login...");
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

    console.log("2) Preenchendo login...");
    await page.locator('input[id="1"]').fill(DOMINIO);
    await page.locator('input[id="2"]').fill(CPF);
    await page.locator('input[id="3"]').fill(USER);
    await page.locator('input[id="4"]').fill(PASS);

    console.log("3) Entrando...");
    await page.locator('a[id="5"]').click();
    await page.waitForLoadState("networkidle");
    console.log("4) Logado:", page.url());
    await debugScreenshot(page, "motoristas047_pos_login.png");

    // 1ª passada: quem teve movimento no último ano (base de motoristas que rodam).
    console.log("5) Passada 1/2 — último movimento de 1 ano...");
    const p047 = await abrir047(context, page);
    arquivos.push(
      await baixar047(context, p047, "movimento", {
        f5: umAnoAtrasBR(), f6: hojeBR(), // último movimento: período
        f7: "", f8: "",                   // cadastramento: vazio
      })
    );

    // 2ª passada: recém-cadastrados que ainda NÃO têm movimento (ex.: Luzimar, 03/11/26)
    // — o filtro de último movimento deixa esses de fora.
    console.log(`6) Passada 2/2 — cadastrados nos últimos ${DIAS_CADASTRO} dias...`);
    // Não-fatal: se ninguém foi cadastrado no período o SSW pode nem gerar arquivo.
    try {
      const p047b = await reabrir047(context, page, p047);
      arquivos.push(
        await baixar047(context, p047b, "cadastro", {
          f5: "", f6: "",                                     // último movimento: vazio
          f7: diasAtrasBR(DIAS_CADASTRO), f8: hojeBR(),       // cadastramento: período
        }, 60000)
      );
    } catch (e2) {
      console.error("⚠️ Passada 2 falhou; seguindo só com a passada 1:", e2?.message || String(e2));
      await debugScreenshot(page, "motoristas047_passada2_erro.png");
    }

    await browser.close().catch(() => {});

    if (arquivos.length === 2) {
      console.log("7) Juntando os dois arquivos...");
      outPath = path.join(path.dirname(arquivos[0]), `CSVmotoristasDAG_juntado_${Date.now()}.sswweb`);
      const { daPrimeira, daSegunda } = juntarArquivos047(arquivos[0], arquivos[1], outPath);
      console.log(`   📄 passada 1: ${daPrimeira} linhas | passada 2: ${daSegunda} linhas (CPF repetido é casado no import)`);
    } else {
      outPath = arquivos[0];
    }

    console.log("8) Enviando para a API Dago...");
    await subirMotoristasSsw(outPath);
    console.log("9) Atualização de motoristas (047) concluída.");
  } catch (e) {
    console.error("❌ Falhou:", e);
    throw e;
  } finally {
    await browser.close().catch(() => {});
    // Regra dos robôs de atualização: baixa, usa e apaga (nunca guarda o arquivo).
    for (const f of [...arquivos, outPath].filter(Boolean)) {
      try { fs.rmSync(f, { force: true }); } catch {}
    }
    if (arquivos.length || outPath) console.log("10) Arquivos temporários removidos.");
  }
}

// Abre a opção 047 pelo menu (popup ou mesmo contexto).
async function abrir047(context, page) {
  const existentes = new Set(context.pages());
  const p047Promise = waitForNewPageWithSelector(context, 'input[name="f13"]', 45000, existentes);
  await typeOption(page, "047");

  let p047 = await p047Promise;
  if (!p047) {
    const scope = await scopeWithSelector(page, 'input[name="f13"]', 15000);
    if (scope) p047 = page;
  }
  if (!p047) throw new Error("A opção 047 não abriu (não achei input[name='f13']).");
  console.log("   047 aberta:", p047.url());
  await debugScreenshot(p047, "motoristas047_aberta.png");
  return p047;
}

// Para a 2ª passada: reaproveita o formulário se ele continua na tela depois do download;
// senão volta ao menu e abre a 047 de novo.
async function reabrir047(context, page, p047) {
  if (!p047.isClosed()) {
    const scope = await scopeWithSelector(p047, 'input[name="f13"]', 5000);
    if (scope) {
      console.log("   reaproveitando o formulário da 047 já aberto.");
      return p047;
    }
  }
  console.log("   formulário sumiu; voltando ao menu e abrindo a 047 de novo.");
  if (p047 !== page && !p047.isClosed()) await p047.close().catch(() => {});
  if (!(await scopeWithSelector(page, 'input[name="f3"]', 5000))) {
    await page.goto(MENU_URL, { waitUntil: "domcontentloaded" });
  }
  return abrir047(context, page);
}

// Preenche os filtros, clica ► e salva o CSV (temporário). Devolve o caminho.
async function baixar047(context, p047, rotulo, periodos, timeoutDownloadMs = 180000) {
  await fill(p047, 'input[name="f1"]', "T"); // Relação com a transportadora = todos
  await fill(p047, 'input[name="f2"]', "T"); // Bloqueado = todos
  for (const [campo, valor] of Object.entries(periodos)) {
    await fill(p047, `input[name="${campo}"]`, valor);
  }
  await fill(p047, 'input[name="f13"]', "S"); // Arquivo em Excel = S (dispara o download)
  await debugScreenshot(p047, `motoristas047_filtros_${rotulo}.png`);

  const geraSel = 'a[onclick*="ajaxEnvia(\'IMP\'"], a[id="14"]';
  const geraScope = await scopeWithSelector(p047, geraSel, 30000);
  if (!geraScope) throw new Error("Não achei o botão ► (gerar) do 047.");
  const gera = geraScope.locator(geraSel).first();
  await gera.waitFor({ state: "visible", timeout: 30000 });

  const download = await capturarDownload(context, p047, timeoutDownloadMs, async () => {
    await gera.click();
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.join(process.cwd(), "downloads");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `CSVmotoristasDAG_${rotulo}_${stamp}.sswweb`);
  await download.saveAs(outPath);
  console.log(`   baixado (${rotulo}, temporário):`, outPath);

  validarArquivoExcel(outPath);
  return outPath;
}

// Junta os dois CSVs do 047 num só, no mesmo layout do SSW:
//   "0;" = cabeçalho, "1;" = motorista, "9;" = rodapé.
// Mantém o arquivo 1 inteiro e encaixa as linhas "1;" do arquivo 2 antes do rodapé.
// Latin1 dos dois lados (ida e volta sem perder acento).
function juntarArquivos047(arq1, arq2, destino) {
  const linhas1 = fs.readFileSync(arq1, "latin1").split(/\r?\n/);
  const linhas2 = fs.readFileSync(arq2, "latin1").split(/\r?\n/);

  const dados2 = linhas2.filter((l) => l.startsWith("1;"));
  const daPrimeira = linhas1.filter((l) => l.startsWith("1;")).length;

  let iRodape = linhas1.findIndex((l) => l.startsWith("9;"));
  if (iRodape < 0) iRodape = linhas1.length;
  const saida = [...linhas1.slice(0, iRodape), ...dados2, ...linhas1.slice(iRodape)];

  fs.writeFileSync(destino, saida.join("\r\n"), "latin1");
  return { daPrimeira, daSegunda: dados2.length };
}

// RETRY: tenta até 3x, intervalo de 5 min.
const MAX_TENTATIVAS = Number(process.env.MAX_TENTATIVAS ?? 3);
const INTERVALO_MS = Number(process.env.INTERVALO_MS ?? 5 * 60 * 1000);

(async () => {
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    console.log(`🔁 Tentativa ${tentativa}/${MAX_TENTATIVAS}...`);
    try {
      await runOnce();
      process.exit(0);
    } catch (err) {
      console.error(`❌ Erro na tentativa ${tentativa}:`, err?.stack || err);
      if (tentativa >= MAX_TENTATIVAS) {
        console.error("🛑 Limite de tentativas atingido. Abortando.");
        process.exit(1);
      }
      console.log("⏳ Aguardando 5 minutos...");
      await new Promise((r) => setTimeout(r, INTERVALO_MS));
    }
  }
})();
