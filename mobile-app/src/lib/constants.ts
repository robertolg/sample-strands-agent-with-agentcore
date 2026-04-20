export const API_BASE_URL = (
  (process.env.EXPO_PUBLIC_API_URL as string | undefined) ?? 'http://localhost:3000'
).replace(/\/$/, '')

export const DEFAULT_MODEL_ID = 'eu.amazon.nova-pro-v1:0'
export const DEFAULT_TEMPERATURE = 0.7
export const TEXT_BUFFER_FLUSH_MS = 120

export const ENDPOINTS = {
  chat: '/api/stream/chat',
  stop: '/api/stream/stop',
  elicitationComplete: '/api/stream/elicitation-complete',
  sessionNew: '/api/session/new',
  sessionList: '/api/session/list',
  sessionDelete: '/api/session/delete',
  sessionById: (id: string) => `/api/session/${encodeURIComponent(id)}`,
  conversationHistory: (id: string) => `/api/conversation/history?session_id=${encodeURIComponent(id)}`,
  streamResume: (executionId: string) => `/api/stream/resume?executionId=${encodeURIComponent(executionId)}&cursor=0`,
  health: '/api/health',
  workspaceFiles: (docType: string) => `/api/workspace/files?docType=${encodeURIComponent(docType)}`,
  s3PresignedUrl: '/api/s3/presigned-url',
  codeAgentDownload: (sessionId: string) =>
    `/api/code-agent/workspace-download?sessionId=${encodeURIComponent(sessionId)}`,
}

export interface ModelInfo {
  id: string
  name: string
  provider: string
  description: string
}

export const AVAILABLE_MODELS: ModelInfo[] = [
  { id: 'eu.amazon.nova-pro-v1:0', name: 'Nova Pro', provider: 'Amazon', description: 'High-performance model' },
  { id: 'eu.amazon.nova-lite-v1:0', name: 'Nova Lite', provider: 'Amazon', description: 'Lightweight and efficient model' },
]

export const MODEL_STORAGE_KEY = 'selected_model_id'
