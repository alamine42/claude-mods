export type ActionItem = {
  id: string
  kind: 'action' | 'question'
  text: string
  command?: string
}

declare module 'claude-code' {
  interface PluginState {
    'my-actions': { items: ActionItem[]; isUpdating: boolean }
  }
}
