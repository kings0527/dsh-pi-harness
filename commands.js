// Human slash commands (`/flux` and `/field`) for DeepSeek Harness.
// Mounted as a sibling Cordis row so `pi-harness` itself stays decoupled from
// the optional `commands` service in minimal/headless hosts.

import { getOrCreateFieldRuntime, registerFluxCommands } from './lib/flux.js'

export const name = 'pi-harness-commands'
export const inject = ['commands', 'workingDirectory']

export function apply(ctx) {
  const runtime = getOrCreateFieldRuntime(ctx)
  registerFluxCommands(ctx, {
    runtime,
    getProjectRoot: (exec) => {
      if (!exec?.agent) throw new Error('This command needs an active agent session')
      return ctx.workingDirectory.get(exec.agent.session)
    },
  })
}
