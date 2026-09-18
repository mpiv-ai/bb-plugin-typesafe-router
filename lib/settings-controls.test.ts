import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsControls } from "../components/settings-controls";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

it("renders only the route switch and available harness switches", () => {
  const html = renderToStaticMarkup(createElement(SettingsControls, {
    state: { enabled: true, hasApiKey: true, harnessError: null, harnesses: [
      { id: "codex", displayName: "Codex", available: true, allowed: true },
      { id: "claude-code", displayName: "Claude Code", available: true, allowed: true },
      { id: "pi", displayName: "Pi", available: true, allowed: false },
      { id: "offline", displayName: "Offline", available: false, allowed: false },
    ] }, busy: false, error: null, onEnabled: () => {}, onHarness: () => {},
  }));
  expect((html.match(/role="switch"/g) ?? [])).toHaveLength(4);
  expect(html).not.toMatch(/textarea|type="(?:range|number)"|curation|Models offered|Offline/);
  expect(html).toContain('aria-label="Route first messages"');
  expect(html).toContain('aria-label="Let TypeSafe choose Pi"');
  // Optional local render artifact, ignored by git. This is a fixture, not a live BB page.
  if (existsSync("dist/app.css")) {
    mkdirSync(".scratch", { recursive: true });
    writeFileSync(".scratch/settings-fixture.html", `<!doctype html><html><meta charset="utf-8"><style>${readFileSync("dist/app.css", "utf8")}body{font:15px system-ui;background:#171719;color:#eee;margin:0;padding:40px;--foreground:#eee;--muted-foreground:#a6a6ad;--border:#39393e;--card:#202024;--primary:#65a9ff;--primary-foreground:#151515;--input:#555;--background:#171719}main{max-width:660px;margin:auto}h1{font-size:24px;margin-bottom:8px}.fixture{color:#aaa;margin-bottom:28px}label{display:block;margin-bottom:10px}input{background:#242428;border:1px solid #555;border-radius:6px;padding:10px;width:100%;margin-bottom:28px}</style><main><h1>TypeSafe Router</h1><p class="fixture">Component fixture • synthetic harness catalog • not a live BB install</p><label>TypeSafe API key</label><input type="password" placeholder="API key (BB auto-form placeholder)" disabled><h2>Routing preferences</h2>${html}</main></html>`);
  }
});
