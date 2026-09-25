import type { YoloSettings } from '../../settings/schema/setting.types'
import type { Assistant } from '../../types/assistant.types'

import { DEFAULT_BLOCKED_PREFIXES } from './bash/command-classifier'

/**
 * Chat and Agent runtimes both inherit workspace scope from the selected assistant
 * so restricted Chat tools (e.g. bash) respect the same boundaries as Agent.
 */
export function resolveWorkspaceScopeForRuntimeInput(
  assistant: Assistant | null | undefined,
): Assistant['workspaceScope'] | undefined {
  return assistant?.workspaceScope
}

/**
 * The terminal command blocklist in effect for a run: the user's configured
 * prefixes, or the built-in set when they cleared the setting. Every surface
 * that hands a gateway its options reads it from here, so voice and the native
 * runtime refuse the same commands.
 */
export function resolveBlockedCommandPrefixes(
  settings: YoloSettings,
): string[] {
  return (
    settings.mcp.builtinCapabilityOptions.terminal?.blockedPrefixes ?? [
      ...DEFAULT_BLOCKED_PREFIXES,
    ]
  )
}
