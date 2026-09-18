/** Canonical family identity; effort and vendor wrappers do not create a model. */
export function modelFamilyKey(id: string): string {
  let key = (id.split(/[/:]/).pop() ?? id).toLowerCase().replace(/\[[^\]]*\]/g, "");
  key = key.replace(/-\d{6,8}$/, "").replace(/-(?:none|low|medium|high|xhigh|max|ultra|ultracode)$/, "");
  key = key.replace(/(\d)\.(\d)/g, "$1-$2");
  return key.replace(/^claude-(\d+(?:-\d+)?)-(opus|sonnet|haiku)$/, "claude-$2-$1");
}
