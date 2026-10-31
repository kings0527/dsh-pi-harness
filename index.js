// Pi Harness Bridge — shared file state, tools, doctrine and recoverable references.
import { boardTool, handoffTool, knowledgeTool } from './lib/tools.js'
import { doctrineText } from './lib/doctrine.js'
import { createReferenceDelivery } from './lib/injection.js'
import { DEFAULT_REFERENCE_BUDGET_TOKENS, MIN_REFERENCE_BUDGET_TOKENS } from './lib/reference.js'

export const name = 'pi-harness'
export const inject = ['tools', 'workingDirectory', 'systemPrompt']

export function apply(ctx, config = {}) {
  const settings = {
    injectReference: config.injectReference !== false,
    doctrine: config.doctrine !== false,
    referenceBudgetTokens: Number.isFinite(config.referenceBudgetTokens)
      ? Math.max(MIN_REFERENCE_BUDGET_TOKENS, Math.floor(config.referenceBudgetTokens))
      : DEFAULT_REFERENCE_BUDGET_TOKENS,
    checkpointEveryTurns: Number.isFinite(config.checkpointEveryTurns) ? config.checkpointEveryTurns : 12,
    retryBaseMs: Number.isFinite(config.retryBaseMs) ? Math.max(0, config.retryBaseMs) : 1000,
  }
  const delivery = createReferenceDelivery(ctx, settings)
  if (settings.doctrine) {
    ctx.effect(() => ctx.systemPrompt.section({ name: 'pi-harness-doctrine', order: 900, text: doctrineText() }))
  }
  for (const factory of [boardTool, knowledgeTool, handoffTool]) {
    const definition = factory({
      getProjectRoot: (exec) => delivery.rootFor(exec?.agent),
      getActiveScopes: (exec) => exec?.agent ? [...delivery.stateFor(exec.agent).activeScopes] : [],
      pageBudgetTokens: settings.referenceBudgetTokens,
    })
    ctx.effect(() => ctx.tools.register(definition))
  }
}
