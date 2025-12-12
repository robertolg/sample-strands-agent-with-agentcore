'use client';

import React from 'react';
import { MessageSquare, Trash2 } from 'lucide-react';
import { SidebarMenu, SidebarMenuItem } from '@/components/ui/sidebar';
import { ChatSession } from '@/hooks/useChatSessions';

interface ChatSessionListProps {
  sessions: ChatSession[];
  currentSessionId: string | null;
  isLoading: boolean;
  onLoadSession?: (sessionId: string) => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
}

export function ChatSessionList({
  sessions,
  currentSessionId,
  isLoading,
  onLoadSession,
  onDeleteSession,
}: ChatSessionListProps) {
  const formatRelativeTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInMs = now.getTime() - date.getTime();
    const diffInMins = Math.floor(diffInMs / 60000);
    const diffInHours = Math.floor(diffInMs / 3600000);
    const diffInDays = Math.floor(diffInMs / 86400000);

    if (diffInMins < 1) return 'Just now';
    if (diffInMins < 60) return `${diffInMins}m ago`;
    if (diffInHours < 24) return `${diffInHours}h ago`;
    if (diffInDays < 7) return `${diffInDays}d ago`;
    return date.toLocaleDateString();
  };

  const handleDeleteSession = async (sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering session load

    try {
      await onDeleteSession(sessionId);
    } catch (error) {
      alert('Failed to delete session. Please try again.');
    }
  };

  if (isLoading) {
    return (
      <SidebarMenu className="p-2">
        <div className="text-center py-8 text-sidebar-foreground/60">
          <p className="text-sm">Loading sessions...</p>
        </div>
      </SidebarMenu>
    );
  }

  if (sessions.length === 0) {
    return (
      <SidebarMenu className="p-2">
        <div className="text-center py-8 text-sidebar-foreground/60">
          <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <p className="text-sm">No chat history yet</p>
          <p className="text-xs mt-1 opacity-60">Start a conversation to see it here</p>
        </div>
      </SidebarMenu>
    );
  }

  return (
    <SidebarMenu className="p-2">
      {sessions.map((session) => (
        <SidebarMenuItem key={session.sessionId} className="group">
          <div
            className={`flex items-start gap-2 p-3 md:p-2.5 rounded-lg hover:bg-sidebar-accent transition-colors cursor-pointer relative ${
              session.sessionId === currentSessionId ? 'bg-sidebar-accent/50 ring-1 ring-primary/20' : ''
            }`}
            onClick={() => {
              if (onLoadSession) {
                onLoadSession(session.sessionId);
              }
            }}
          >
            <MessageSquare className="h-4 w-4 mt-0.5 text-sidebar-foreground/60 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm text-sidebar-foreground truncate">
                {session.title}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-sidebar-foreground/60">
                  {session.messageCount} messages
                </span>
                <span className="text-xs text-sidebar-foreground/40">•</span>
                <span className="text-xs text-sidebar-foreground/60">
                  {formatRelativeTime(session.lastMessageAt)}
                </span>
              </div>
            </div>
            {/* Delete button - shows on hover on desktop, always visible on mobile */}
            <button
              onClick={(e) => handleDeleteSession(session.sessionId, e)}
              className="md:opacity-0 md:group-hover:opacity-100 transition-opacity p-2 md:p-1.5 rounded hover:bg-destructive/10 text-sidebar-foreground/60 hover:text-destructive flex-shrink-0"
              title="Delete session"
            >
              <Trash2 className="h-4 w-4 md:h-3.5 md:w-3.5" />
            </button>
          </div>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
