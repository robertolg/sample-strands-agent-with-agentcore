"use client"

import React from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Trash2 } from 'lucide-react'

interface InterruptApprovalModalProps {
  isOpen: boolean
  onApprove: () => void
  onReject: () => void
  interrupts: Array<{
    id: string
    name: string
    reason?: Record<string, any>
  }>
}

export function InterruptApprovalModal({
  isOpen,
  onApprove,
  onReject,
  interrupts
}: InterruptApprovalModalProps) {
  const interrupt = interrupts[0]

  if (!interrupt) return null

  const query = interrupt.reason?.query || ""
  const intent = interrupt.reason?.intent || ""
  const maxDelete = interrupt.reason?.max_delete || 50

  return (
    <Dialog open={isOpen} onOpenChange={() => {}}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-500/10">
              <Trash2 className="w-5 h-5 text-red-500" />
            </div>
            <div>
              <DialogTitle>Delete Emails</DialogTitle>
              <DialogDescription className="text-xs">
                This action cannot be undone
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
          <p className="text-sm text-foreground">{intent}</p>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span>Query: <code className="px-1.5 py-0.5 rounded bg-muted text-foreground">{query}</code></span>
            <span>Max: <strong className="text-foreground">{maxDelete}</strong></span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onReject}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onApprove}
            className="bg-red-600 hover:bg-red-700"
          >
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
