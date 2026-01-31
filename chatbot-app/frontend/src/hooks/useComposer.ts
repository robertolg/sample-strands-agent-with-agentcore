/**
 * useComposer Hook - Document composition workflow management
 *
 * Manages state and logic for document composition using ComposerWorkflow
 */

import { useState, useCallback } from 'react'
import { startComposition, confirmOutline, ComposeEvent } from '@/lib/composer-client'

export interface Outline {
  title: string
  sections: OutlineSection[]
  total_estimated_words: number
  version: number
}

export interface OutlineSection {
  section_id: string
  title: string
  description: string
  subsections?: OutlineSection[]
  estimated_words: number
}

export interface ComposedDocument {
  title: string
  content: string
  wordCount: number
}

export interface ComposeState {
  isComposing: boolean
  progress: string
  outline: Outline | null
  showOutlineConfirm: boolean
  outlineAttempt: number
  documentParts: string[]
  completedDocument: ComposedDocument | null
  error: string | null
}

export interface ArtifactData {
  id: string
  type: string
  title: string
  content: string
  tool_name?: string
  metadata?: Record<string, any>
  created_at?: string
  updated_at?: string
}

export interface UseComposerOptions {
  sessionId: string | null
  onDocumentComplete?: (doc: ComposedDocument) => void
  onArtifactCreated?: (artifact: ArtifactData) => void
}

export function useComposer({ sessionId, onDocumentComplete, onArtifactCreated }: UseComposerOptions) {
  const [state, setState] = useState<ComposeState>({
    isComposing: false,
    progress: '',
    outline: null,
    showOutlineConfirm: false,
    outlineAttempt: 1,
    documentParts: [],
    completedDocument: null,
    error: null,
  })

  /**
   * Handle compose events from backend
   */
  const handleEvent = useCallback((event: ComposeEvent) => {
    console.log('Compose event:', event.type, event)

    switch (event.type) {
      case 'writing_progress':
        setState(prev => ({
          ...prev,
          progress: `${event.task_name}: ${event.details}`,
        }))
        break

      case 'writing_outline':
        setState(prev => ({
          ...prev,
          outline: event.outline,
          outlineAttempt: event.attempt || 1,
        }))
        break

      case 'interrupt':
        // Outline ready for confirmation
        setState(prev => ({
          ...prev,
          showOutlineConfirm: true,
          isComposing: false,
        }))
        break

      case 'text':
        // Collect document parts
        setState(prev => ({
          ...prev,
          documentParts: [...prev.documentParts, event.content],
        }))
        break

      case 'writing_complete':
        // Document finished
        setState(prev => {
          const fullContent = prev.documentParts.join('')
          const doc: ComposedDocument = {
            title: event.document_title,
            content: fullContent,
            wordCount: event.word_count || 0,
          }

          // Call completion callback
          if (onDocumentComplete) {
            onDocumentComplete(doc)
          }

          return {
            ...prev,
            completedDocument: doc,
            isComposing: false,
            progress: 'Document completed!',
          }
        })
        break

      case 'error':
        setState(prev => ({
          ...prev,
          error: event.message || 'An error occurred',
          isComposing: false,
        }))
        break

      case 'artifact_created':
        // Artifact saved to backend - notify parent to update artifacts list
        if (onArtifactCreated && event.artifact) {
          console.log('[useComposer] Artifact created:', event.artifact.id)
          onArtifactCreated(event.artifact)
        }
        break
    }
  }, [onDocumentComplete, onArtifactCreated])

  /**
   * Start composing a document
   */
  const startCompose = useCallback(async (
    message: string,
    modelId?: string,
    temperature?: number
  ) => {
    if (!sessionId) {
      console.error('No session ID available')
      return
    }

    setState({
      isComposing: true,
      progress: 'Starting document composition...',
      outline: null,
      showOutlineConfirm: false,
      outlineAttempt: 1,
      documentParts: [],
      completedDocument: null,
      error: null,
    })

    try {
      await startComposition(
        {
          sessionId,
          message,
          modelId,
          temperature,
        },
        handleEvent
      )
    } catch (error) {
      console.error('Compose start error:', error)
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to start composition',
        isComposing: false,
      }))
    }
  }, [sessionId, handleEvent])

  /**
   * Confirm or reject outline
   */
  const confirmOutlineResponse = useCallback(async (approved: boolean, feedback?: string) => {
    if (!sessionId) {
      console.error('No session ID available')
      return
    }

    setState(prev => ({
      ...prev,
      showOutlineConfirm: false,
      isComposing: true,
      progress: approved ? 'Writing document...' : 'Revising outline...',
      documentParts: [], // Reset document parts
    }))

    try {
      await confirmOutline(
        {
          sessionId,
          approved,
          feedback,
        },
        handleEvent
      )
    } catch (error) {
      console.error('Outline confirm error:', error)
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to confirm outline',
        isComposing: false,
      }))
    }
  }, [sessionId, handleEvent])

  /**
   * Reset composer state
   */
  const reset = useCallback(() => {
    setState({
      isComposing: false,
      progress: '',
      outline: null,
      showOutlineConfirm: false,
      outlineAttempt: 1,
      documentParts: [],
      completedDocument: null,
      error: null,
    })
  }, [])

  return {
    ...state,
    startCompose,
    confirmOutlineResponse,
    reset,
  }
}
