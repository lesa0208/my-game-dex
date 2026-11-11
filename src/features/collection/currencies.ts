/** ISO 4217 currencies, with English names, made once on the server so the browser renders the same list. */
const names = new Intl.DisplayNames(["en"], { type: "currency" });

export const CURRENCIES = Intl.supportedValuesOf("currency").map((code) => ({ code, name: names.of(code) ?? code }));
