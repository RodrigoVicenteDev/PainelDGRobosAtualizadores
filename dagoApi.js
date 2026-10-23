// dagoApi.js — comunicação com a API Dago para os robôs de atualização.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const fs = require("fs");

const BASE_URL = process.env.DAGO_API_BASE ?? "https://api.paineldg.com.br";

async function readJsonSafe(res) {
  const txt = await res.text().catch(() => "");
  try {
    return { json: JSON.parse(txt), txt };
  } catch {
    return { json: null, txt };
  }
}

function summarizeBody(txt, max = 1500) {
  if (!txt) return "";
  const s = String(txt);
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && typeof obj === "object" && obj[k]) return obj[k];
  }
  return null;
}

// -------------------- LOGIN --------------------
async function dagoLogin(email, senha) {
  console.log("API) Autenticando na API Dago...");

  const res = await fetch(`${BASE_URL}/api/Auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, senha }),
  });

  const { json, txt } = await readJsonSafe(res);
  if (!res.ok) {
    console.error(`❌ Login falhou (${res.status}):`, summarizeBody(txt) || res.statusText);
    throw new Error(`Login API Dago falhou (${res.status})`);
  }

  const token =
    pick(json, ["token", "accessToken", "access_token"]) ||
    pick(json?.data, ["token", "accessToken", "access_token"]) ||
    pick(json?.result, ["token", "accessToken", "access_token"]);

  if (!token) {
    console.error("❌ Login OK, mas token não encontrado. JSON:", json);
    throw new Error("Login OK, mas token não encontrado");
  }

  console.log("API) Login OK.");
  return token;
}

// -------------------- MOTORISTAS (opção 047) --------------------
async function subirMotoristasSsw(arquivoPath) {
  console.log("API) Enviando cadastro de motoristas SSW (047) para a API Dago...");

  if (!fs.existsSync(arquivoPath)) {
    throw new Error(`Arquivo não encontrado: ${arquivoPath}`);
  }

  const email = process.env.DAGO_EMAIL ?? "";
  const senha = process.env.DAGO_SENHA ?? "";
  if (!email || !senha) {
    throw new Error("Defina DAGO_EMAIL e DAGO_SENHA no .env.");
  }

  const authToken = await dagoLogin(email, senha);

  const form = new FormData();
  const blob = new Blob([fs.readFileSync(arquivoPath)], { type: "text/csv" });
  form.append("Arquivo", blob, path.basename(arquivoPath));

  const res = await fetch(`${BASE_URL}/api/motoristas-ssw/importar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}` },
    body: form,
  });

  const { json, txt } = await readJsonSafe(res);
  if (!res.ok) {
    console.error(`❌ Importar motoristas falhou (${res.status}):`, summarizeBody(txt) || res.statusText);
    throw new Error(`Importar motoristas SSW falhou (${res.status})`);
  }

  console.log("API) Importação concluída:", summarizeBody(JSON.stringify(json?.resultado ?? json)));
  return json;
}

// -------------------- VEÍCULOS (opção 045) --------------------
async function subirVeiculosSsw(arquivoPath) {
  console.log("API) Enviando cadastro de veículos SSW (045) para a API Dago...");

  if (!fs.existsSync(arquivoPath)) {
    throw new Error(`Arquivo não encontrado: ${arquivoPath}`);
  }

  const email = process.env.DAGO_EMAIL ?? "";
  const senha = process.env.DAGO_SENHA ?? "";
  if (!email || !senha) {
    throw new Error("Defina DAGO_EMAIL e DAGO_SENHA no .env.");
  }

  const authToken = await dagoLogin(email, senha);

  const form = new FormData();
  const blob = new Blob([fs.readFileSync(arquivoPath)], { type: "text/csv" });
  form.append("Arquivo", blob, path.basename(arquivoPath));

  const res = await fetch(`${BASE_URL}/api/veiculos-ssw/importar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}` },
    body: form,
  });

  const { json, txt } = await readJsonSafe(res);
  if (!res.ok) {
    console.error(`❌ Importar veículos falhou (${res.status}):`, summarizeBody(txt) || res.statusText);
    throw new Error(`Importar veículos SSW falhou (${res.status})`);
  }

  console.log("API) Importação concluída:", summarizeBody(JSON.stringify(json?.resultado ?? json)));
  return json;
}

// -------------------- TABELA DE FRETE (opção 417 → ssw1620) --------------------
// Esses endpoints exigem Bearer (login) + X-Robo-Token (ROBO_TOKEN do .env).
function roboToken() {
  const t = process.env.ROBO_TOKEN ?? "";
  if (!t) throw new Error("Defina ROBO_TOKEN no .env (mesmo segredo do back).");
  return t;
}

// Pergunta à API qual CNPJ o robô deve puxar (informado pelo front). null = nada pendente.
async function obterAlvoTabelaFrete() {
  const email = process.env.DAGO_EMAIL ?? "";
  const senha = process.env.DAGO_SENHA ?? "";
  if (!email || !senha) throw new Error("Defina DAGO_EMAIL e DAGO_SENHA no .env.");

  const authToken = await dagoLogin(email, senha);
  const res = await fetch(`${BASE_URL}/api/tabela-frete/robo/alvo`, {
    headers: { Authorization: `Bearer ${authToken}`, "X-Robo-Token": roboToken() },
  });

  const { json, txt } = await readJsonSafe(res);
  if (!res.ok) {
    console.error(`❌ Consultar CNPJ alvo falhou (${res.status}):`, summarizeBody(txt) || res.statusText);
    throw new Error(`Consultar CNPJ alvo falhou (${res.status})`);
  }
  return json?.cnpj ?? null;
}

async function subirTabelaFreteSsw(arquivoPath) {
  console.log("API) Enviando tabela de frete SSW (1620) para a API Dago...");

  if (!fs.existsSync(arquivoPath)) throw new Error(`Arquivo não encontrado: ${arquivoPath}`);

  const email = process.env.DAGO_EMAIL ?? "";
  const senha = process.env.DAGO_SENHA ?? "";
  if (!email || !senha) throw new Error("Defina DAGO_EMAIL e DAGO_SENHA no .env.");

  const authToken = await dagoLogin(email, senha);

  const form = new FormData();
  const blob = new Blob([fs.readFileSync(arquivoPath)], { type: "text/csv" });
  form.append("Arquivo", blob, path.basename(arquivoPath));

  const res = await fetch(`${BASE_URL}/api/tabela-frete/robo/importar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}`, "X-Robo-Token": roboToken() },
    body: form,
  });

  const { json, txt } = await readJsonSafe(res);
  if (!res.ok) {
    console.error(`❌ Importar tabela de frete falhou (${res.status}):`, summarizeBody(txt) || res.statusText);
    throw new Error(`Importar tabela de frete SSW falhou (${res.status})`);
  }

  console.log("API) Importação concluída:", summarizeBody(JSON.stringify(json)));
  return json;
}

// -------------------- MAPA DE PRAÇAS (opção 601 → ssw0752) --------------------
// Sobe no endpoint robô (Bearer + X-Robo-Token). O endpoint mapa-pracas/robo/importar
// entra no back no "resto" (hoje só existe mapa-pracas/importar, com permissão de página).
async function subirMapaPracasSsw(arquivoPath) {
  console.log("API) Enviando mapa de praças SSW (0752) para a API Dago...");

  if (!fs.existsSync(arquivoPath)) throw new Error(`Arquivo não encontrado: ${arquivoPath}`);

  const email = process.env.DAGO_EMAIL ?? "";
  const senha = process.env.DAGO_SENHA ?? "";
  if (!email || !senha) throw new Error("Defina DAGO_EMAIL e DAGO_SENHA no .env.");

  const authToken = await dagoLogin(email, senha);

  const form = new FormData();
  const blob = new Blob([fs.readFileSync(arquivoPath)], { type: "text/csv" });
  form.append("arquivo", blob, path.basename(arquivoPath));

  const res = await fetch(`${BASE_URL}/api/tabela-frete/mapa-pracas/robo/importar`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}`, "X-Robo-Token": roboToken() },
    body: form,
  });

  const { json, txt } = await readJsonSafe(res);
  if (!res.ok) {
    console.error(`❌ Importar mapa de praças falhou (${res.status}):`, summarizeBody(txt) || res.statusText);
    throw new Error(`Importar mapa de praças SSW falhou (${res.status})`);
  }

  console.log("API) Importação concluída:", summarizeBody(JSON.stringify(json)));
  return json;
}

module.exports = {
  dagoLogin,
  subirMotoristasSsw,
  subirVeiculosSsw,
  obterAlvoTabelaFrete,
  subirTabelaFreteSsw,
  subirMapaPracasSsw,
};
