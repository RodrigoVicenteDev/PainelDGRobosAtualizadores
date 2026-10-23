// motoristas047.js — Robô de ATUALIZAÇÃO: cadastro de motoristas do SSW (opção 047 / ssw0067).
//
// Fluxo: login SSW -> opção 047 -> preenche
//   Relação = T (todos), Bloqueado = T (todos),
//   Último movimento (período) = (hoje - 1 ano) até hoje,  Arquivo em Excel = S
//   -> clica ► (com Excel=S o SSW já baixa o CSV direto, sem passar pela fila 156)
//   -> sobe o arquivo na API Dago (POST /api/motoristas-ssw/importar).
//
// Vars no .env (ver .env.example):
//   SITE_DOMINIO, SITE_CPF, SITE_USER, SITE_PASS  (login SSW)
//   DAGO_API_BASE, DAGO_EMAIL, DAGO_SENHA         (API Dago)
//   HEADLESS=1 (0 p/ ver o navegador), SLOWMO, DEBUG=1 (prints em debug/)
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
function umAnoAtrasBR() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return ddMMyy(partesBR(d));
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
    await debugScreenshot(page, "motoristas047_pos_login.png");

    console.log('5) Abrindo opção 047...');
    const existentes = new Set(context.pages());
    const p047Promise = waitForNewPageWithSelector(context, 'input[name="f13"]', 45000, existentes);
    await typeOption(page, "047");

    // Pode abrir em popup ou no mesmo contexto; cobre os dois casos.
    let p047 = await p047Promise;
    if (!p047) {
      const scope = await scopeWithSelector(page, 'input[name="f13"]', 15000);
      if (scope) p047 = page;
    }
    if (!p047) throw new Error("A opção 047 não abriu (não achei input[name='f13']).");
    console.log("6) 047 aberta:", p047.url());
    await debugScreenshot(p047, "motoristas047_aberta.png");

    console.log("7) Preenchendo filtros...");
    await fill(p047, 'input[name="f1"]', "T"); // Relação com a transportadora = todos
    await fill(p047, 'input[name="f2"]', "T"); // Bloqueado = todos
    await fill(p047, 'input[name="f5"]', umAnoAtrasBR()); // último movimento: início
    await fill(p047, 'input[name="f6"]', hojeBR());       // último movimento: fim
    await fill(p047, 'input[name="f13"]', "S"); // Arquivo em Excel = S (dispara o download)
    await debugScreenshot(p047, "motoristas047_filtros.png");

    console.log("8) Clicando ► e capturando o download...");
    const geraSel = 'a[onclick*="ajaxEnvia(\'IMP\'"], a[id="14"]';
    const geraScope = await scopeWithSelector(p047, geraSel, 30000);
    if (!geraScope) throw new Error("Não achei o botão ► (gerar) do 047.");
    const gera = geraScope.locator(geraSel).first();
    await gera.waitFor({ state: "visible", timeout: 30000 });

    const download = await capturarDownload(context, p047, 180000, async () => {
      await gera.click();
    });

    let suggested = (download.suggestedFilename() || "").trim();
    if (!suggested || !/\.(sswweb|csv|xls|xlsx|txt)$/i.test(suggested)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      suggested = `CSVmotoristasDAG_${stamp}.sswweb`;
    }

    const outDir = path.join(process.cwd(), "downloads");
    fs.mkdirSync(outDir, { recursive: true });
    outPath = path.join(outDir, suggested);
    await download.saveAs(outPath);
    console.log("9) Baixado (temporário):", outPath);

    validarArquivoExcel(outPath);

    await browser.close().catch(() => {});

    console.log("10) Enviando para a API Dago...");
    await subirMotoristasSsw(outPath);
    console.log("11) Atualização de motoristas (047) concluída.");
  } catch (e) {
    console.error("❌ Falhou:", e);
    throw e;
  } finally {
    await browser.close().catch(() => {});
    // Regra dos robôs de atualização: baixa, usa e apaga (nunca guarda o arquivo).
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
