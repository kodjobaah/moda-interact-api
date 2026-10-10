import { createHash } from "node:crypto";
import type { ModaSupportedLanguageTag } from "@modainteract/moda-interact-shared/internationalization";

/** This is an informational browser return only. It never confirms a grant. */
const MESSAGES: Readonly<Record<ModaSupportedLanguageTag, Readonly<{ approved: string; cancelled: string }>>> = {
  "zh-Hans": {
    approved: "请返回 WooCommerce 管理后台。Moda Interact 将在核实商店后确认只读访问权限。",
    cancelled: "WooCommerce 授权未完成。请返回 WooCommerce 重试。",
  },
  "zh-Hant": {
    approved: "請返回 WooCommerce 管理後台。Moda Interact 將在驗證商店後確認唯讀存取權限。",
    cancelled: "WooCommerce 授權尚未完成。請返回 WooCommerce 重試。",
  },
  cs: {
    approved: "Vraťte se do administrace WooCommerce. Moda Interact potvrdí přístup pro čtení po ověření obchodu.",
    cancelled: "Autorizace WooCommerce nebyla dokončena. Vraťte se do WooCommerce a zkuste to znovu.",
  },
  da: {
    approved: "Gå tilbage til WooCommerce-administrationen. Moda Interact bekræfter læseadgangen, når butikken er kontrolleret.",
    cancelled: "WooCommerce-godkendelsen blev ikke gennemført. Gå tilbage til WooCommerce, og prøv igen.",
  },
  nl: {
    approved: "Ga terug naar je WooCommerce-beheeromgeving. Moda Interact bevestigt de leestoegang nadat de winkel is gecontroleerd.",
    cancelled: "De WooCommerce-autorisatie is niet voltooid. Ga terug naar WooCommerce om het opnieuw te proberen.",
  },
  en: {
    approved: "Return to your WooCommerce admin. Moda Interact will confirm read access after checking the store.",
    cancelled: "WooCommerce authorization was not completed. Return to WooCommerce to try again.",
  },
  fi: {
    approved: "Palaa WooCommercen hallintapaneeliin. Moda Interact vahvistaa lukuoikeuden tarkistettuaan kaupan.",
    cancelled: "WooCommerce-valtuutusta ei viimeistelty. Palaa WooCommerceen ja yritä uudelleen.",
  },
  fr: {
    approved: "Retournez dans l’administration de WooCommerce. Moda Interact confirmera l’accès en lecture après vérification de la boutique.",
    cancelled: "L’autorisation WooCommerce n’a pas été finalisée. Retournez dans WooCommerce pour réessayer.",
  },
  de: {
    approved: "Kehren Sie zum WooCommerce-Administrationsbereich zurück. Moda Interact bestätigt den Lesezugriff, nachdem der Shop überprüft wurde.",
    cancelled: "Die WooCommerce-Autorisierung wurde nicht abgeschlossen. Kehren Sie zu WooCommerce zurück, um es erneut zu versuchen.",
  },
  it: {
    approved: "Torna all’area amministrativa di WooCommerce. Moda Interact confermerà l’accesso in lettura dopo aver verificato il negozio.",
    cancelled: "L’autorizzazione di WooCommerce non è stata completata. Torna a WooCommerce per riprovare.",
  },
  ja: {
    approved: "WooCommerce の管理画面に戻ってください。Moda Interact はストアを確認した後、読み取りアクセスを確定します。",
    cancelled: "WooCommerce の認証は完了しませんでした。WooCommerce に戻って、もう一度お試しください。",
  },
  ko: {
    approved: "WooCommerce 관리자 화면으로 돌아가세요. Moda Interact가 스토어를 확인한 후 읽기 권한을 확인합니다.",
    cancelled: "WooCommerce 승인이 완료되지 않았습니다. WooCommerce로 돌아가 다시 시도하세요.",
  },
  nb: {
    approved: "Gå tilbake til WooCommerce-administrasjonen. Moda Interact bekrefter lesetilgang etter å ha kontrollert butikken.",
    cancelled: "WooCommerce-godkjenningen ble ikke fullført. Gå tilbake til WooCommerce og prøv igjen.",
  },
  pl: {
    approved: "Wróć do panelu administracyjnego WooCommerce. Moda Interact potwierdzi dostęp do odczytu po sprawdzeniu sklepu.",
    cancelled: "Autoryzacja WooCommerce nie została ukończona. Wróć do WooCommerce i spróbuj ponownie.",
  },
  "pt-BR": {
    approved: "Volte ao painel administrativo do WooCommerce. O Moda Interact confirmará o acesso de leitura após verificar a loja.",
    cancelled: "A autorização do WooCommerce não foi concluída. Volte ao WooCommerce e tente novamente.",
  },
  "pt-PT": {
    approved: "Regresse à administração do WooCommerce. O Moda Interact confirmará o acesso de leitura depois de verificar a loja.",
    cancelled: "A autorização do WooCommerce não foi concluída. Regresse ao WooCommerce e tente novamente.",
  },
  es: {
    approved: "Vuelve a la administración de WooCommerce. Moda Interact confirmará el acceso de lectura después de comprobar la tienda.",
    cancelled: "La autorización de WooCommerce no se completó. Vuelve a WooCommerce para intentarlo de nuevo.",
  },
  sv: {
    approved: "Gå tillbaka till WooCommerce-administrationen. Moda Interact bekräftar läsåtkomsten efter att butiken har kontrollerats.",
    cancelled: "WooCommerce-auktoriseringen slutfördes inte. Gå tillbaka till WooCommerce och försök igen.",
  },
  th: {
    approved: "กลับไปที่หน้าผู้ดูแลระบบ WooCommerce จากนั้น Moda Interact จะยืนยันสิทธิ์การอ่านหลังจากตรวจสอบร้านค้าแล้ว",
    cancelled: "การอนุญาต WooCommerce ยังไม่เสร็จสมบูรณ์ กลับไปที่ WooCommerce แล้วลองอีกครั้ง",
  },
  tr: {
    approved: "WooCommerce yönetim panelinize dönün. Moda Interact, mağazayı kontrol ettikten sonra okuma erişimini onaylayacaktır.",
    cancelled: "WooCommerce yetkilendirmesi tamamlanmadı. Yeniden denemek için WooCommerce'e dönün.",
  },
};

const STYLES = `
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#183f31;background:#f3f8f5}
*{box-sizing:border-box}
body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px}
main{width:min(100%,560px);padding:36px;border:1px solid #dceae1;border-radius:18px;background:#fff;box-shadow:0 12px 38px rgba(22,69,46,.07)}
.brand{margin:0 0 14px;font-size:.78rem;font-weight:750;letter-spacing:.06em;text-transform:uppercase;color:#286247}
h1{margin:0 0 14px;font-size:clamp(1.5rem,4vw,2rem);line-height:1.25}
p.message{margin:0;color:#3f5950;font-size:1rem;line-height:1.7;overflow-wrap:anywhere}
`;
const STYLE_HASH = createHash("sha256").update(STYLES).digest("base64");

function escapeHtml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (character) => entities[character] ?? character);
}

export function renderWooReadReturnPage(locale: ModaSupportedLanguageTag, cancelled: boolean): {
  html: string;
  contentSecurityPolicy: string;
} {
  const message = MESSAGES[locale][cancelled ? "cancelled" : "approved"];
  return {
    html: `<!doctype html><html lang="${escapeHtml(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Moda Interact</title><style>${STYLES}</style></head><body><main><p class="brand">WooCommerce</p><h1>Moda Interact</h1><p class="message">${escapeHtml(message)}</p></main></body></html>`,
    contentSecurityPolicy: `default-src 'none'; style-src 'sha256-${STYLE_HASH}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}
