# Contributing

## Local development

```
git clone https://github.com/mpiv-ai/bb-plugin-typesafe-router.git
cd bb-plugin-typesafe-router
npm install
```

Checks, all of which should pass before you open a pull request:

```
npm test          # catalog curation, dispatch policy, the routing pass, the bridge
npx tsc --noEmit  # types
bb plugin build   # the plugin bundles
```

No test reaches the network: the catalog is passed in, the routing pass takes a
`SystemOneCaller` a fake satisfies, and the bridge is driven in-process through
the SDK's own JSON-RPC harness. Keep it that way — a test that needs a TypeSafe
API key is a test nobody else can run.

## Running your working copy in BB

Install the checkout by path instead of by git ref:

```
bb plugin install . --yes
bb plugin config typesafe-router set typesafeApiKey 'YOUR_KEY'
bb plugin reload typesafe-router
```

`bb plugin reload typesafe-router` after every change. Never commit an API key;
the key lives in BB's plugin config, which is not in this repository.

## Where things live

See the **Layout** section of the [README](README.md#layout). The short version:
`lib/` is pure and tested, `server.ts` is the wiring, `app.tsx` is the UI, and
`skills/typesafe-router/SKILL.md` is what agents are told.

The one invariant worth knowing: a turn never starts on the TypeSafe Router
picker row. That rule is applied in `lib/policy.ts` over the whole decision, not
inside any one branch, so a new branch cannot forget it. If you add a path that
releases a dispatch, it goes through `decideDispatch`.

## Pull requests

- Keep commits focused and the message in the imperative mood.
- Do not add harness or model attribution to commits or pull requests.
- Update the README, `PLUGIN_OVERVIEW.md`, and `skills/typesafe-router/SKILL.md`
  together when behaviour a user can see changes — the marketplace listing is
  generated from the overview.
