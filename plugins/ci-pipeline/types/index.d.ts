export type Mark = 'done' | 'running' | 'failed' | 'waiting' | 'pending'

export type Stage = { name: string; mark: Mark; note?: string }

export type Pipeline = {
  branch: string | null
  pr: { number: number; title: string; url: string } | null
  stages: Stage[]
  error?: string
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'ci-pipeline': { pipeline: Pipeline | null; pinned: number | null }
  }
}
