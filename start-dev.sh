export MODA_WOOCOMMERCE_CONNECTION_MODE=local-development
export MODA_WOO_REST_READ_PUBLIC_ORIGIN="https://85ba-2a0a-ef40-8d3-fa01-4c9b-4d10-fbd6-b9f0.ngrok-free.app"
export MODA_WOO_REST_READ_ACTIVE_KEY_ID="local-v1"

export MODA_WOO_REST_READ_KEYRING="$(node -e '
const crypto = require("node:crypto");
console.log(JSON.stringify({
  "local-v1": crypto.randomBytes(32).toString("base64url")
}));
')"

npm run dev
