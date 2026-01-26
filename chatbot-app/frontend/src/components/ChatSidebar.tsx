'use client';

import React, { useState } from 'react';
import { Menu, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sidebar,
  SidebarHeader,
  SidebarMenu,
  useSidebar,
} from '@/components/ui/sidebar';
import { ChatSessionList } from './sidebar/ChatSessionList';
import { useChatSessions } from '@/hooks/useChatSessions';

interface ChatSidebarProps {
  sessionId: string | null;
  onNewChat: () => void;
  loadSession?: (sessionId: string) => Promise<void>;
}

export function ChatSidebar({
  sessionId,
  onNewChat,
  loadSession,
}: ChatSidebarProps) {
  const { toggleSidebar } = useSidebar();
  const [isConfirmDialogOpen, setIsConfirmDialogOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Use custom hooks
  const { chatSessions, isLoadingSessions, deleteSession, deleteAllSessions } = useChatSessions({
    sessionId,
    onNewChat,
  });

  const handleClearAll = async () => {
    setIsDeleting(true);
    try {
      await deleteAllSessions();
      setIsConfirmDialogOpen(false);
    } catch (error) {
      alert('Failed to clear all chats. Please try again.');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Sidebar
      side="left"
      className="group-data-[side=left]:border-r-0 bg-sidebar-background border-sidebar-border text-sidebar-foreground flex flex-col h-full"
    >
      {/* Header - Hamburger menu */}
      <SidebarHeader className="flex-shrink-0 px-3 py-3 border-b-0">
        <SidebarMenu>
          <div className="flex flex-row items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleSidebar}
              className="h-9 w-9 p-0 hover:bg-sidebar-accent"
              title="Close sidebar"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </div>
        </SidebarMenu>
      </SidebarHeader>

      {/* New Chat Button */}
      <div className="px-3 pb-4">
        <Button
          variant="ghost"
          onClick={onNewChat}
          className="w-full justify-start gap-3 h-11 px-3 hover:bg-sidebar-accent text-sidebar-foreground"
        >
          <Plus className="h-5 w-5" />
          <span className="text-[15px] font-medium">New chat</span>
        </Button>
      </div>

      {/* Chats Section */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="px-4 pb-2 flex-shrink-0 flex items-center justify-between">
          <span className="text-[13px] font-medium text-sidebar-foreground/60 uppercase tracking-wide">Chats</span>
          {chatSessions.length > 0 && (
            <button
              onClick={() => setIsConfirmDialogOpen(true)}
              className="text-sidebar-foreground/40 hover:text-destructive transition-colors"
              title="Clear all chats"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto">
          <ChatSessionList
            sessions={chatSessions}
            currentSessionId={sessionId}
            isLoading={isLoadingSessions}
            onLoadSession={loadSession}
            onDeleteSession={deleteSession}
          />
        </div>
      </div>

      {/* Clear All Confirmation Dialog */}
      <Dialog open={isConfirmDialogOpen} onOpenChange={setIsConfirmDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Clear all chats?</DialogTitle>
            <DialogDescription>
              This will permanently delete all your chat sessions. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setIsConfirmDialogOpen(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleClearAll}
              disabled={isDeleting}
            >
              {isDeleting ? 'Deleting...' : 'Delete all'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  );
}
