// DSH Host plugin: exposes a local, offline translation endpoint so the
// built-in reasoning translation ("思考过程翻译") runs against llama.cpp on this
// machine instead of Bing or Google.
//
// The endpoint speaks the Google `translate_a/single` protocol, so the profile
// only has to repoint `translator.googleEndpoint` — no fork of DeepSeek
// Harness, and the GUI, session caching and request splitting all keep working.

import { startLocalTranslator, DEFAULTS } from './server.js'

export const name = 'pi-harness-local-translator'

// No `inject`: the shim is plain HTTP and must not depend on the translator
// rows, which may be mounted later in the same transaction.
export function apply(ctx, config = {}) {
  const settings = {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)),
  }
  const log = (message) => ctx.logger?.info?.(`local-translator: ${message}`)

  let handle = null
  let starting = null
  let disposed = false

  const start = () => {
    if (handle || starting) return starting ?? Promise.resolve(handle)
    starting = startLocalTranslator(settings, log)
      .then((started) => {
        handle = started
        if (!started.reuse) log(`listening on ${started.url} → ${settings.upstream}`)
        return started
      })
      .catch((error) => {
        // Fail soft: a broken shim must not take the whole Host down. The
        // translator row then surfaces a normal provider error in the GUI.
        log(`unavailable: ${error?.message ?? error}`)
        return null
      })
      .finally(() => {
        starting = null
      })
    return starting
  }

  ctx.effect(() => {
    void start()
    return () => {
      disposed = true
      handle?.close?.()
      handle = null
    }
  })

  return { start, isDisposed: () => disposed }
}
