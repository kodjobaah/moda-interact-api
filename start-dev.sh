#!/usr/bin/env bash
set -euo pipefail
: "${MODA_ENCRYPTION_KEYS_JSON:?Provide the deployment encryption key map}"
: "${MODA_ENCRYPTION_ACTIVE_KEY_ID:?Provide the active encryption key ID}"
export MODA_WOOCOMMERCE_CONNECTION_MODE=local-development
export MODA_WOO_REST_READ_PUBLIC_ORIGIN="https://danny-providers-bean-acoustic.trycloudflare.com"

PORT=3100 npm run dev 
