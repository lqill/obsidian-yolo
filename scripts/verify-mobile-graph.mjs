import { readFile } from 'node:fs/promises'

import builtins from 'builtin-modules'

/**
 * Mobile static-graph ratchet.
 *
 * Obsidian's mobile app loads the same `main.js` as the desktop app inside a
 * WebView: there is no second bundle and no conditional resolution, so anything
 * the host *statically* imports has to load on a phone. Obsidian ships
 * `isDesktopOnly: false`, which means the desktop-only surfaces are hidden in
 * the UI — not that their imports are safe.
 *
 * esbuild lowers dynamic imports here (`supported['dynamic-import']: false` in
 * `esbuild.config.mjs`), so every `await import(...)` becomes a lazy `require()`
 * that mobile never evaluates unless that branch runs. Those files may and do
 * import `node:*`; that is the whole point of the dynamic-import discipline.
 * `import-statement` edges may not: a Node builtin reached statically is
 * guaranteed to execute when a phone loads the bundle.
 *
 * Walk from `src/main.ts` over static edges only and fail on anything mobile
 * cannot load. Wired into `npm run build` as `mobile:verify`.
 */

/** The bundle's entry point — the graph mobile actually loads. */
const ENTRY = 'src/main.ts'

/** Statically imported, therefore guaranteed to run on a phone. */
const STATIC_EDGE = 'import-statement'

/**
 * Exactly the externals `esbuild.config.mjs` leaves unbundled that a WebView
 * cannot resolve: `node:*` builtins (bare and `node:`-prefixed) and Electron.
 * The other externals there — `obsidian`, `@codemirror/*`, `@lezer/*`,
 * `@lexical/clipboard/clipboard` — are supplied by the Obsidian host on every
 * platform, so they are not violations.
 */
const FORBIDDEN = new Set([
  'electron',
  ...builtins,
  ...builtins.map((name) => `node:${name}`),
])

const metafile = JSON.parse(await readFile('meta.json', 'utf8'))
const inputs = new Map(
  Object.entries(metafile.inputs).map(([path, entry]) => [
    path.replaceAll('\\', '/'),
    entry,
  ]),
)

const walk = () => {
  const seen = new Set()
  const queue = [ENTRY]
  const violations = []

  while (queue.length > 0) {
    const current = queue.pop()
    if (seen.has(current)) continue
    seen.add(current)

    const entry = inputs.get(current)
    if (!entry)
      throw new Error(`Mobile graph walk reached an unknown input: ${current}`)
    for (const record of entry.imports ?? []) {
      if (record.kind !== STATIC_EDGE || record.external) continue
      const specifier = record.path.replaceAll('\\', '/')
      if (FORBIDDEN.has(specifier)) {
        violations.push(`${current} -> ${specifier}`)
        continue
      }
      queue.push(specifier)
    }
  }

  return { visited: seen.size, violations }
}

const { visited, violations } = walk()

if (violations.length > 0) {
  throw new Error(
    `Statically reachable desktop-only imports (${violations.length}). Each one runs when a mobile device loads main.js:\n${violations
      .map((violation) => `  ${violation}`)
      .join('\n')}`,
  )
}

console.log(`Mobile static graph verified (${visited} modules, 0 violations)`)
