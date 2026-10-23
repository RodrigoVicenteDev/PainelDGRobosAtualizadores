#!/bin/bash
# Wrapper do robô de atualização de VEÍCULOS (opção 045) — cron/escutador.
export TZ=America/Sao_Paulo

# pasta deste script (portável: funciona em qualquer caminho do servidor)
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$BASE_DIR" || exit 1

# carrega o Node 20 via nvm, se existir (cron não carrega sozinho)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use 20 >/dev/null 2>&1

# carrega variáveis do .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

LOG_DIR="$BASE_DIR/logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/cron_veiculos_$(date +%F).log"

LOCK_FILE="/tmp/robo-veiculos045.lock"

{
  echo "[$(date)] 🔐 Tentando adquirir lock..."
  flock -n 200 || { echo "[$(date)] ⛔ Já há uma execução em andamento. Abortando."; exit 0; }
  echo "[$(date)] ✅ Lock adquirido. Iniciando robô de veículos..."
  node veiculos045.js
  echo "[$(date)] ✅ Robô finalizado."
} 200>"$LOCK_FILE" >> "$LOG" 2>&1
