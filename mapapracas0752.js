// mapapracas0752.js — Robô de ATUALIZAÇÃO: mapa de praças (cidades atendidas) do SSW.
// Tela: SSW / Cliente / EDI / opção 601 "Gera arquivo de cidades atendidas" (prog ssw0752).
//
// O mapa é GLOBAL (um arquivo só, substitui tudo) — sem CNPJ.
// Layout das 12 colunas (confirmado; o parser ImportarMapaAsync já lê essa ordem):
//   Coluna 1 = Nome da cidade · 2 = UF da cidade · 3 = Sigla da praca ·
//   4 = Praca Comercial · 5 = CEP Inicial · 6 = CEP Final · 7..12 = Não usar.
// "Apenas dados da Unidade" (f14) = vazio (traz todas). Botão ► = ajaxEnvia('ENV',0) / id=15.
// Saída: 0;CIDADE_NOME;CIDADE_UF;PRACA_SIGLA;PRACA_COMERCIAL_SIGLA;CEP_INI;CEP_FIN
//
// Vars no .env (ver .env.example):
//   SITE_DOMINIO, SITE_CPF, SITE_USER, SITE_PASS  (login SSW)
//   DAGO_API_BASE, DAGO_EMAIL, DAGO_SENHA, ROBO_TOKEN   (API Dago)
//   HEADLESS=1 (0 p/ ver o navegador), SLOWMO, DEBUG=1 (prints em debug/)
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const fs = require("fs");
const { chromium } = require("playwright");
const { subirMapaPracasSsw } = require("./dagoApi");

// ================= LOG =================
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function nowLog() {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

const LOG_FILE = path.join(LOG_DIR, `mapapracas0752_${new Date().toISOString().slice(0, 10)}.log`);
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

// ================= HELPERS SSW (frames imprevisíveis) =================
const LOGIN_URL = "https://sistema.ssw.inf.br/bin/ssw0422";

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

// Define uma coluna do lay-out (select sem value → seleciona pelo texto/label).
async function setColuna(scope, nome, label) {
  const loc = scope.locator(`select[name="${nome}"]`).first();
  await loc.waitFor({ state: "visible", timeout: 30000 });
  await loc.selectOption({ label });
  const v = await loc.inputValue().catch(() => "");
  console.log(`   ✍️  ${nome} = ${JSON.stringify(label)} (value ${JSON.stringify(v)})`);
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
  let outPath = null;

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
    await debugScreenshot(page, "mapapracas_pos_login.png");

    console.log("5) Abrindo opção 601...");
    const existentes = new Set(context.pages());
    const pPromise = waitForNewPageWithSelector(context, 'select[name="f1"]', 45000, existentes);
    await typeOption(page, "601");

    let p601 = await pPromise;
    if (!p601) {
      const scope = await scopeWithSelector(page, 'select[name="f1"]', 15000);
      if (scope) p601 = page;
    }
    if (!p601) throw new Error("A opção 601 não abriu (não achei select[name='f1']).");
    console.log("6) 601 aberta:", p601.url());
    await debugScreenshot(p601, "mapapracas_aberta.png");

    console.log("7) Montando o lay-out das 12 colunas...");
    const scope = await scopeWithSelector(p601, 'select[name="f1"]', 30000);
    if (!scope) throw new Error("Não achei os selects de coluna (f1).");
    await setColuna(scope, "f1", "Nome da cidade");
    await setColuna(scope, "f2", "UF da cidade");
    await setColuna(scope, "f3", "Sigla da praca");
    await setColuna(scope, "f4", "Praca Comercial");
    await setColuna(scope, "f5", "CEP Inicial");
    await setColuna(scope, "f6", "CEP Final");
    // f7..f12 ficam em "Não usar" (default).
    await debugScreenshot(p601, "mapapracas_layout.png");

    console.log("8) Clicando ► e capturando o download...");
    const geraSel = 'a[onclick*="ajaxEnvia(\'ENV\'"], a[id="15"]';
    const geraScope = await scopeWithSelector(p601, geraSel, 30000);
    if (!geraScope) throw new Error("Não achei o botão ► (gerar) do 601.");
    const gera = geraScope.locator(geraSel).first();
    await gera.waitFor({ state: "visible", timeout: 30000 });

    const download = await capturarDownload(context, p601, 180000, async () => {
      await gera.click();
    });

    let suggested = (download.suggestedFilename() || "").trim();
    if (!suggested || !/\.(sswweb|csv|xls|xlsx|txt)$/i.test(suggested)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      suggested = `CSVssw0752DAG_${stamp}.sswweb`;
    }

    const outDir = path.join(process.cwd(), "downloads");
    fs.mkdirSync(outDir, { recursive: true });
    outPath = path.join(outDir, suggested);
    await download.saveAs(outPath);
    console.log("9) Baixado (temporário):", outPath);

    // valida que parece o mapa de praças (ssw0752)
    const head = fs.readFileSync(outPath, "latin1").split(/\r?\n/).slice(0, 5).join("\n");
    if (!/PRACA/i.test(head) || !head.includes(";")) {
      throw new Error("Arquivo não parece o mapa de praças (sem PRACA/';'). As colunas foram montadas certo?");
    }

    await browser.close().catch(() => {});

    console.log("10) Enviando para a API Dago...");
    await subirMapaPracasSsw(outPath);
    console.log("11) Atualização do mapa de praças concluída.");
  } catch (e) {
    console.error("❌ Falhou:", e);
    throw e;
  } finally {
    await browser.close().catch(() => {});
    // Regra dos robôs de atualização: baixa, usa e apaga.
    if (outPath) {
      try {
        fs.rmSync(outPath, { force: true });
        console.log("12) Arquivo temporário removido.");
      } catch {}
    }
  }
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
