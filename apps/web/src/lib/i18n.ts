// Blueprint: docs/system-analysis/17-technical-blueprint.md §8.10 "Internationalisation, RTL
// and typography"; docs/system-analysis/00b-owner-decisions-and-requirements.md D15
// ("Bilingual -- English and Urdu, switchable. The single largest accessibility decision;
// shapes every screen.").
//
// Phase 1: the i18n plumbing is real and wired at the app root (src/app/providers.tsx); the
// message catalogues are placeholders. As screens are built, move their strings out of JSX
// and into these resource objects -- never inline English text with no translation key
// (§8.10 "message catalogues extracted and lint-checked for missing keys").
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

export const SUPPORTED_LOCALES = ["en", "ur"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** RTL locales, per §8.10 ("Logical CSS properties + `dir` on the document root"). */
export const RTL_LOCALES: readonly SupportedLocale[] = ["ur"];

const resources = {
  en: {
    translation: {
      app: {
        name: "Pharmacy",
      },
      shell: {
        loading: "Loading...",
        apiUnreachable: "The server could not be reached.",
      },
      surfaces: {
        counter: "Counter",
        backoffice: "Back office",
        insights: "Insights",
      },
    },
  },
  ur: {
    translation: {
      app: {
        name: "فارمیسی",
      },
      shell: {
        loading: "لوڈ ہو رہا ہے...",
        apiUnreachable: "سرور تک رسائی نہیں ہو سکی۔",
      },
      surfaces: {
        counter: "کاؤنٹر",
        backoffice: "بیک آفس",
        insights: "بصیرت",
      },
    },
  },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export function applyDocumentDirection(locale: SupportedLocale): void {
  document.documentElement.lang = locale;
  document.documentElement.dir = RTL_LOCALES.includes(locale) ? "rtl" : "ltr";
}

export default i18n;
