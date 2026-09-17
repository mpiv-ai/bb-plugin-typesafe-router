// The `bb.host` artifact. It exists for one reason: BB refuses a provider
// declaration from a plugin that ships no host entry, and the picker stub is a
// provider declaration. Everything it does lives in `lib/provider-bridge.ts`.

export { experimental_providerBridge } from "./lib/provider-bridge.js";
