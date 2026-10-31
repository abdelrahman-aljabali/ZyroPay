// Web bundle only (metro.config.js): stands in for zod's `locales` namespace, which would
// otherwise bundle all ~45 translations (~270 KB minified). ZyroPay only uses the default
// English messages, which zod's schemas import directly from locales/en.js.
export { default as en } from "zod/v4/locales/en.js";
