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

module.exports = { dagoLogin, subirMotoristasSsw };
