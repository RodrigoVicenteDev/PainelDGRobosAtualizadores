// tabelafrete1620.js — Robô de ATUALIZAÇÃO: tabela de frete do SSW (opção 417 / ssw1591 → CSV ssw1620).
//
// O CNPJ vem do front: o back guarda o CNPJ alvo e dispara este robô pelo escutador.
// Fluxo: pergunta o CNPJ em /api/tabela-frete/robo/alvo -> login SSW -> opção 417
//   -> digita o CNPJ (campo f2) -> clica "Excel" (ajaxEnvia('IMPRCSV'))
//   -> no popup: Imprimir tabelas = A (ambas), Simulação = N (só reais) -> clica ►
//   -> baixa o CSV ssw1620 -> sobe em /api/tabela-frete/robo/importar.
//
// Auth dos endpoints robô = Bearer (login) + X-Robo-Token (ROBO_TOKEN do .env).
//
// Vars no .env (ver .env.example):
//   SITE_DOMINIO, SITE_CPF, SITE_USER, SITE_PASS  (login SSW)
//   DAGO_API_BASE, DAGO_EMAIL, DAGO_SENHA, ROBO_TOKEN   (API Dago)
//   HEADLESS=1 (0 p/ ver o navegador), SLOWMO, DEBUG=1 (prints em debug/)
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const fs = require("fs");
const { chromium } = require("playwright");
const { obterAlvoTabelaFrete, subirTabelaFreteSsw } = require("./dagoApi");

// ================= LOG =================
const LOG_DIR = path.join(process.cwd(), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function nowLog() {
  return new Date().toISOString().replace("T", " ").substring(0, 19);
}

const LOG_FILE = path.join(LOG_DIR, `tabelafrete1620_${new Date().toISOString().slice(0, 10)}.log`);
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
  return scope;
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

// Popup "SSW Web" do Excel (campos confirmados no HTML):
//   Imprimir tabelas = name="-3" (maxlength 1) → A (ambas)
//   Simulação        = name="-2" (maxlength 2) → N (só reais; decisão do usuário)
//   ►                = a[onclick*="IMP2S"] (id="-1")
async function configurarPopupExcel(page) {
  const sc = await scopeWithSelector(page, 'input[name="-2"]', 15000);
  if (!sc) {
    console.log("   ⚠️ popup do Excel não encontrado (input name=-2); seguindo com os defaults.");
    return;
  }
  const setField = async (sel, val) => {
    const loc = sc.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) {
      console.log(`   ⚠️ campo ${sel} não achado no popup.`);
      return;
    }
    await loc.click({ clickCount: 3 }).catch(() => {});
    await loc.fill(val).catch(() => {});
    console.log(`   ✍️  popup ${sel} =`, JSON.stringify(await loc.inputValue().catch(() => "")));
  };
  await setField('input[name="-3"]', "A"); // Imprimir tabelas = ambas
  await setField('input[name="-2"]', "N"); // Simulação = só reais
}

// Clica a seta ► do popup (ajaxEnvia('IMP2S', 0)).
async function clicarSetaPopup(page) {
  const sel = 'a[onclick*="IMP2S"]';
  const sc = await scopeWithSelector(page, sel, 15000);
  if (!sc) throw new Error("Não achei a ► do popup do Excel (IMP2S).");
  await sc.locator(sel).first().click();
}

async function runOnce(cnpj) {
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
    await debugScreenshot(page, "tabelafrete_pos_login.png");

    console.log("5) Abrindo opção 417...");
    const existentes = new Set(context.pages());
    const p417Promise = waitForNewPageWithSelector(context, 'input[name="f2"]', 45000, existentes);
    await typeOption(page, "417");

    let p417 = await p417Promise;
    if (!p417) {
      const scope = await scopeWithSelector(page, 'input[name="f2"]', 15000);
      if (scope) p417 = page;
    }
    if (!p417) throw new Error("A opção 417 não abriu (não achei input[name='f2']).");
    console.log("6) 417 aberta:", p417.url());
    await debugScreenshot(p417, "tabelafrete_aberta.png");

    console.log(`7) Preenchendo CNPJ ${cnpj}...`);
    const scope = await fill(p417, 'input[name="f2"]', cnpj);
    await scope.locator('input[name="f2"]').first().press("Tab").catch(() => {}); // dispara lecnpj (busca o nome)
    await p417.waitForTimeout(1200);
    await debugScreenshot(p417, "tabelafrete_cnpj.png");

    console.log("8) Clicando 'Excel' (gera o ssw1620)...");
    const excelSel = 'a[onclick*="IMPRCSV"], a[id="11"]';
    const excelScope = await scopeWithSelector(p417, excelSel, 30000);
    if (!excelScope) throw new Error("Não achei o link 'Excel' (IMPRCSV) do 417.");
    await excelScope.locator(excelSel).first().click();

    console.log("9) Configurando o popup (Imprimir=A, Simulação=N)...");
    await p417.waitForTimeout(1500);
    await configurarPopupExcel(p417);
    await debugScreenshot(p417, "tabelafrete_popup.png");

    console.log("10) Clicando ► do popup e capturando o download...");
    const download = await capturarDownload(context, p417, 180000, async () => {
      await clicarSetaPopup(p417);
    });

    let suggested = (download.suggestedFilename() || "").trim();
    if (!suggested || !/\.(sswweb|csv|xls|xlsx|txt)$/i.test(suggested)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      suggested = `CSVtabelafreteDAG_${stamp}.sswweb`;
    }

    const outDir = path.join(process.cwd(), "downloads");
    fs.mkdirSync(outDir, { recursive: true });
    outPath = path.join(outDir, suggested);
    await download.saveAs(outPath);
    console.log("11) Baixado (temporário):", outPath);

    // valida que parece o ssw1620 (combinada)
    const head = fs.readFileSync(outPath, "latin1").split(/\r?\n/).slice(0, 6).join("\n");
    if (!/CNPJ;ORIGEM;DESTINO/i.test(head)) {
      throw new Error("Arquivo não parece o ssw1620 (sem cabeçalho CNPJ;ORIGEM;DESTINO). O 'Excel' gerou o CSV certo?");
    }

    await browser.close().catch(() => {});

    console.log("12) Enviando para a API Dago...");
    await subirTabelaFreteSsw(outPath);
    console.log("13) Atualização da tabela de frete concluída.");
  } catch (e) {
    console.error("❌ Falhou:", e);
    throw e;
  } finally {
    await browser.close().catch(() => {});
    // Regra dos robôs de atualização: baixa, usa e apaga.
    if (outPath) {
      try {
        fs.rmSync(outPath, { force: true });
        console.log("14) Arquivo temporário removido.");
      } catch {}
    }
  }
}

// RETRY: tenta até 3x, intervalo de 5 min.
const MAX_TENTATIVAS = Number(process.env.MAX_TENTATIVAS ?? 3);
const INTERVALO_MS = Number(process.env.INTERVALO_MS ?? 5 * 60 * 1000);

(async () => {
  // CNPJ: aceita forçar por argumento ou env CNPJ_ALVO (teste/manual).
  // Sem isso, pergunta à API qual CNPJ puxar (o front informou).
  let cnpj = (process.argv[2] || process.env.CNPJ_ALVO || "").replace(/\D/g, "");
  if (cnpj) {
    console.log(`CNPJ informado manualmente (sem consultar a API): ${cnpj}`);
  } else {
    try {
      cnpj = await obterAlvoTabelaFrete();
    } catch (err) {
      console.error("❌ Não consegui perguntar o CNPJ alvo à API:", err?.stack || err);
      process.exit(1);
    }
    if (!cnpj) {
      console.log("Nenhum CNPJ pendente para puxar. Encerrando.");
      process.exit(0);
    }
    console.log(`CNPJ alvo recebido da API: ${cnpj}`);
  }

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    console.log(`🔁 Tentativa ${tentativa}/${MAX_TENTATIVAS}...`);
    try {
      await runOnce(cnpj);
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
