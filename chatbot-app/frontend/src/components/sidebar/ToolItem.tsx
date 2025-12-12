'use client';

import React from 'react';
import { Tool } from '@/types/chat';
import { Switch } from '@/components/ui/switch';
import { SidebarMenuItem } from '@/components/ui/sidebar';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface ToolItemProps {
  tool: Tool;
  onToggleTool: (toolId: string) => void;
}

export function ToolItem({ tool, onToggleTool }: ToolItemProps) {
  // Check if this is a grouped tool (isDynamic)
  const isDynamic = (tool as any).isDynamic === true;
  const nestedTools = (tool as any).tools || [];

  if (isDynamic) {
    // Render as group with nested tools
    const anyToolEnabled = nestedTools.some((nestedTool: any) => nestedTool.enabled);
    const allToolsEnabled = nestedTools.every((nestedTool: any) => nestedTool.enabled);

    return (
      <SidebarMenuItem key={tool.id}>
        <div className="flex items-center justify-between p-3 md:p-2 rounded-md hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors duration-150">
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm text-sidebar-foreground truncate">
              {tool.name}
            </div>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="text-xs text-sidebar-foreground/70 truncate cursor-help">
                    {tool.description}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs">
                  <p>{tool.description}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <div className="text-xs mt-1">
              <span className="text-blue-600">● {nestedTools.length} tools</span>
            </div>
          </div>
          <Switch
            checked={anyToolEnabled}
            onCheckedChange={async () => {
              // If all tools are enabled, disable all
              // If some or none are enabled, enable all
              const shouldEnable = !allToolsEnabled;

              // Toggle each nested tool sequentially to avoid race conditions
              for (const nestedTool of nestedTools) {
                // Only toggle if the tool's current state doesn't match the target state
                if (nestedTool.enabled !== shouldEnable) {
                  await onToggleTool(nestedTool.id);
                }
              }
            }}
            className="ml-3 md:ml-2 flex-shrink-0"
          />
        </div>
      </SidebarMenuItem>
    );
  } else {
    // Render as individual tool
    return (
      <SidebarMenuItem key={tool.id}>
        <div className="flex items-center justify-between p-3 md:p-2 rounded-md hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors duration-150">
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm text-sidebar-foreground truncate">
              {tool.name}
            </div>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="text-xs text-sidebar-foreground/70 truncate cursor-help">
                    {tool.description}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-xs">
                  <p>{tool.description}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Switch
            checked={tool.enabled}
            onCheckedChange={() => onToggleTool(tool.id)}
            className="ml-3 md:ml-2 flex-shrink-0"
          />
        </div>
      </SidebarMenuItem>
    );
  }
}
