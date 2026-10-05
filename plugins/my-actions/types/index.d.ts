export type ActionItem = {
  id: string
  kind: 'action' | 'question'
  // For an action: 'you' when only the person can do it, 'agent' when the agent could.
  owner?: 'you' | 'agent'
  text: string
  command?: string
}

declare module 'claude-code' {
  interface PluginState {
    'my-actions': { items: ActionItem[]; isUpdating: boolean }
  }
}
