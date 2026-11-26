// Pi Harness Bridge — shared file state, tools, doctrine, Live Flux field and recoverable references.
import { boardTool, handoffTool, knowledgeTool } from './lib/tools.js'
import { doctrineText } from './lib/doctrine.js'
import { createReferenceDelivery } from './lib/injection.js'
import { DEFAULT_REFERENCE_BUDGET_TOKENS, MIN_REFERENCE_BUDGET_TOKENS } from './lib/reference.js'
import {
  fieldTool,
  fluxTool,
  getOrCreateFieldRuntime,
  installFieldRuntime,
  registerFluxCommands,
} from './lib/flux.js'

export const name = 'pi-harness'
export const inject = ['tools', 'workingDirectory', 'systemPrompt']

export function apply(ctx, config = {}) {
  const settings = {
    injectReference: config.injectReference !== false,
    doctrine: config.doctrine !== false,
    liveField: config.liveField !== false,
    referenceBudgetTokens: Number.isFinite(config.referenceBudgetTokens)
      ? Math.max(MIN_REFERENCE_BUDGET_TOKENS, Math.floor(config.referenceBudgetTokens))
      : DEFAULT_REFERENCE_BUDGET_TOKENS,
    checkpointEveryTurns: Number.isFinite(config.checkpointEveryTurns) ? config.checkpointEveryTurns : 12,
    retryBaseMs: Number.isFinite(config.retryBaseMs) ? Math.max(0, config.retryBaseMs) : 1000,
  }
  const delivery = createReferenceDelivery(ctx, settings)
  const getProjectRoot = (exec) => delivery.rootFor(exec?.agent)
  const fieldRuntime = getOrCreateFieldRuntime(ctx)

  if (settings.doctrine) {
    ctx.effect(() => ctx.systemPrompt.section({ name: 'pi-harness-doctrine', order: 900, text: doctrineText() }))
  }
  if (settings.liveField) {
    installFieldRuntime(ctx, fieldRuntime, { getProjectRoot })
    // If a host already has `commands` mounted synchronously, register `/flux` & `/field` directly;
    // otherwise the sibling `@local/dsh-pi-harness/commands` row registers them once `commands` boots.
    registerFluxCommands(ctx, { runtime: fieldRuntime, getProjectRoot })
  }

  for (const factory of [boardTool, knowledgeTool, handoffTool]) {
    const definition = factory({
      getProjectRoot,
      getActiveScopes: (exec) => exec?.agent ? [...delivery.stateFor(exec.agent).activeScopes] : [],
      pageBudgetTokens: settings.referenceBudgetTokens,
    })
    ctx.effect(() => ctx.tools.register(definition))
  }

  if (settings.liveField) {
    for (const definition of [
      fieldTool({ runtime: fieldRuntime, getProjectRoot }),
      fluxTool({ ctx, runtime: fieldRuntime, getProjectRoot }),
    ]) {
      ctx.effect(() => ctx.tools.register(definition))
    }
  }
}
