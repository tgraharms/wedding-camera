import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement the HTMLInputElement.capture IDL attribute (a
// mobile-only, non-core HTML feature): setting the `capture` content
// attribute works, but reading the `.capture` property back gives
// `undefined` instead of reflecting it, the way a real browser does.
// Landing.test.tsx asserts on the property to verify the capture input is
// wired to the native camera, so polyfill the reflection here.
if (typeof HTMLInputElement !== "undefined" && !("capture" in HTMLInputElement.prototype)) {
  Object.defineProperty(HTMLInputElement.prototype, "capture", {
    get(this: HTMLInputElement) {
      return this.getAttribute("capture") ?? "";
    },
    set(this: HTMLInputElement, value: string) {
      this.setAttribute("capture", value);
    },
    configurable: true,
  });
}
