"""
Browser automation tools using AgentCore Browser + Nova Act.
Each tool returns a screenshot to show current browser state.
"""

import os
import logging
from typing import Dict, Any, Optional, List
from strands import tool, ToolContext
from .lib.browser_controller import get_or_create_controller

logger = logging.getLogger(__name__)


def _format_tab_summary(tabs: List[Dict], current_tab: int = 0) -> str:
    """Format tab list as a compact summary string.

    Args:
        tabs: List of tab info dicts with 'index', 'title', 'is_current'
        current_tab: Current tab index (fallback if is_current not in tabs)

    Returns:
        Formatted string like: "**Tabs** (3): [0] Google | [1] Amazon <- | [2] GitHub"
        Returns empty string if only one tab.
    """
    if not tabs or len(tabs) <= 1:
        return ""

    tab_parts = []
    for tab in tabs:
        title = tab.get('title', 'Untitled')[:20]  # Truncate long titles
        is_current = tab.get('is_current', tab['index'] == current_tab)
        marker = " <-" if is_current else ""
        tab_parts.append(f"[{tab['index']}] {title}{marker}")

    return f"**Tabs** ({len(tabs)}): " + " | ".join(tab_parts)


def _format_tab_list_detailed(tabs: List[Dict]) -> str:
    """Format tab list with full details for get_page_info.

    Args:
        tabs: List of tab info dicts

    Returns:
        Formatted multi-line string with full tab details
    """
    if not tabs:
        return "No tabs open"

    lines = [f"**All Tabs** ({len(tabs)}):"]
    for tab in tabs:
        title = tab.get('title', 'Untitled')[:50]
        url = tab.get('url', 'about:blank')
        marker = "  <- current" if tab.get('is_current') else ""
        lines.append(f"  [{tab['index']}] {title}{marker}")
        lines.append(f"      {url}")

    return "\n".join(lines)


@tool(context=True)
def browser_navigate(url: str, tool_context: ToolContext) -> Dict[str, Any]:
    """
    Navigate browser to a URL and capture the loaded page with screenshot.

    Args:
        url: Complete URL to navigate to

    Returns screenshot showing the loaded page.
    """
    try:
        # Get session_id from ToolContext to avoid race condition with os.environ
        # Try invocation_state first, then agent's session_manager
        session_id = tool_context.invocation_state.get("session_id")
        if not session_id and hasattr(tool_context.agent, '_session_manager'):
            session_id = tool_context.agent._session_manager.session_id
            logger.info(f"[browser_navigate] Using session_id from agent._session_manager: {session_id}")
        elif session_id:
            logger.info(f"[browser_navigate] Using session_id from invocation_state: {session_id}")
        else:
            raise ValueError("session_id not found in ToolContext")

        controller = get_or_create_controller(session_id)
        result = controller.navigate(url)

        if result["status"] == "success":
            # Format tab summary if multiple tabs
            tab_summary = _format_tab_summary(
                result.get('tabs', []),
                result.get('current_tab', 0)
            )
            tab_line = f"\n{tab_summary}" if tab_summary else ""

            # Prepare response with screenshot (code interpreter format)
            content = [{
                "text": f"""✅ **Navigated successfully**

**URL**: {result.get('current_url', url)}
**Page Title**: {result.get('page_title', 'N/A')}{tab_line}

Current page is shown in the screenshot below."""
            }]

            # Add screenshot as image content (raw bytes, like code interpreter)
            if result.get("screenshot"):
                content.append({
                    "image": {
                        "format": "jpeg",
                        "source": {
                            "bytes": result["screenshot"]  # Raw bytes
                        }
                    }
                })

            # Get browser session info for Live View
            # Note: URL generation moved to BFF for on-demand refresh capability
            metadata = {}
            if controller.browser_session_client and controller.browser_session_client.session_id:
                metadata["browserSessionId"] = controller.browser_session_client.session_id
                if controller.browser_id:
                    metadata["browserId"] = controller.browser_id

            return {
                "content": content,
                "status": "success",
                "metadata": metadata
            }
        else:
            return {
                "content": [{
                    "text": f"❌ **Navigation failed**\n\n{result.get('message', 'Unknown error')}"
                }],
                "status": "error"
            }

    except Exception as e:
        logger.error(f"browser_navigate failed: {e}")
        return {
            "content": [{
                "text": f"❌ **Navigation error**: {str(e)}"
            }],
            "status": "error"
        }


@tool(context=True)
def browser_act(instruction: str, tool_context: ToolContext) -> Dict[str, Any]:
    """
    Execute browser UI actions using an agent. Handles sequential visible UI tasks.

    Capabilities:
    - Actions: click, type, scroll, select dropdowns
    - Can execute 2-3 related steps in sequence when visible on screen

    Limitations:
    - Does NOT support drag operations - use browser_drag instead for drawing, resizing, or moving elements
    - Has 3-step limit. If fails, simplify instruction or try different tool
    - For DOM attributes, use browser_get_page_info()

    Args:
        instruction: Natural language instruction for UI actions.

                    Sequential steps: "Type 'laptop' in search box and click search button"
                    Single step: "Click the login button" (when exploring unknown page)

    Returns screenshot showing the result.
    """
    try:
        # Get session_id from ToolContext to avoid race condition with os.environ
        session_id = tool_context.invocation_state.get("session_id")
        if not session_id and hasattr(tool_context.agent, '_session_manager'):
            session_id = tool_context.agent._session_manager.session_id
            logger.info(f"[browser_act] Using session_id from agent._session_manager: {session_id}")
        elif session_id:
            logger.info(f"[browser_act] Using session_id from invocation_state: {session_id}")
        else:
            raise ValueError("session_id not found in ToolContext")

        controller = get_or_create_controller(session_id)
        result = controller.act(instruction)

        status_emoji = "✅" if result["status"] == "success" else "⚠️"

        # Format tab summary if multiple tabs
        tab_summary = _format_tab_summary(
            result.get('tabs', []),
            result.get('current_tab', 0)
        )
        tab_line = f"\n{tab_summary}" if tab_summary else ""

        content = [{
            "text": f"""{status_emoji} **Action executed**

**Instruction**: {instruction}
**Result**: {result.get('message', 'Action completed')}
**Current URL**: {result.get('current_url', 'N/A')}
**Page Title**: {result.get('page_title', 'N/A')}{tab_line}

Current page state is shown in the screenshot below."""
        }]

        # Add screenshot as image content (raw bytes, like code interpreter)
        if result.get("screenshot"):
            content.append({
                "image": {
                    "format": "jpeg",
                    "source": {
                        "bytes": result["screenshot"]  # Raw bytes
                    }
                }
            })

        # Get browser session info for Live View
        metadata = {}
        if controller.browser_session_client and controller.browser_session_client.session_id:
            metadata["browserSessionId"] = controller.browser_session_client.session_id
            if controller.browser_id:
                metadata["browserId"] = controller.browser_id

        return {
            "content": content,
            "status": "success",  # Bedrock API requirement: only "success" or "error"
            "metadata": metadata
        }

    except Exception as e:
        logger.error(f"browser_act failed: {e}")
        return {
            "content": [{
                "text": f"❌ **Action error**: {str(e)}\n\n**Instruction**: {instruction}"
            }],
            "status": "error"
        }


@tool(context=True)
def browser_extract(description: str, extraction_schema: dict, tool_context: ToolContext) -> Dict[str, Any]:
    """
    Extract visible text/numbers from page into structured JSON using an agent.
    Handles multi-screen data collection automatically.

    Capabilities:
    - Auto-scroll and paginate to collect data across multiple screens
    - Detects repeated patterns and extracts systematically

    Limitations:
    - Has 6-step limit. If too complex, break down task or simplify schema
    - For DOM attributes, use browser_get_page_info()

    Args:
        description: What to extract. Example: "Extract all product names and prices"
        extraction_schema: JSON schema with 'type', 'properties', field descriptions.

    Schema Example:
        {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Product title"},
                    "price": {"type": "number", "description": "Price in dollars"}
                }
            }
        }

    Returns extracted data as JSON (no screenshot).
    """
    try:
        # Get session_id from ToolContext to avoid race condition with os.environ
        session_id = tool_context.invocation_state.get("session_id")
        if not session_id and hasattr(tool_context.agent, '_session_manager'):
            session_id = tool_context.agent._session_manager.session_id
            logger.info(f"[browser_extract] Using session_id from agent._session_manager: {session_id}")
        elif session_id:
            logger.info(f"[browser_extract] Using session_id from invocation_state: {session_id}")
        else:
            raise ValueError("session_id not found in ToolContext")

        controller = get_or_create_controller(session_id)

        # Extract data using description and JSON schema
        result = controller.extract(description, schema=extraction_schema)

        if result["status"] == "success":
            import json
            extracted_data_str = json.dumps(result.get("data", {}), indent=2, ensure_ascii=False)
            schema_str = json.dumps(extraction_schema, indent=2, ensure_ascii=False)

            # Format tab summary if multiple tabs
            tab_summary = _format_tab_summary(
                result.get('tabs', []),
                result.get('current_tab', 0)
            )
            tab_line = f"\n{tab_summary}" if tab_summary else ""

            content = [{
                "text": f"""✅ **Data extracted successfully**

**Description**: {description}

**Schema**:
```json
{schema_str}
```

**Current URL**: {result.get('current_url', 'N/A')}
**Page Title**: {result.get('page_title', 'N/A')}{tab_line}

**Extracted Data**:
```json
{extracted_data_str}
```"""
            }]

            # Get browser session info for Live View
            # Note: URL generation moved to BFF for on-demand refresh capability
            metadata = {}
            if controller.browser_session_client and controller.browser_session_client.session_id:
                metadata["browserSessionId"] = controller.browser_session_client.session_id
                if controller.browser_id:
                    metadata["browserId"] = controller.browser_id

            return {
                "content": content,
                "status": "success",
                "metadata": metadata
            }
        else:
            import json
            schema_str = json.dumps(extraction_schema, indent=2, ensure_ascii=False)
            return {
                "content": [{
                    "text": f"❌ **Extraction failed**\n\n{result.get('message', 'Unknown error')}\n\n**Description**: {description}\n\n**Schema**:\n```json\n{schema_str}\n```"
                }],
                "status": "error"
            }

    except Exception as e:
        import json
        logger.error(f"browser_extract failed: {e}")
        schema_str = json.dumps(extraction_schema, indent=2, ensure_ascii=False)
        return {
            "content": [{
                "text": f"❌ **Extraction error**: {str(e)}\n\n**Description**: {description}\n\n**Schema**:\n```json\n{schema_str}\n```"
            }],
            "status": "error"
        }


@tool(context=True)
def browser_get_page_info(tool_context: ToolContext) -> Dict[str, Any]:
    """
    Get page structure and DOM data - FAST (<300ms), no AI needed.

    Returns:
    - URL, title, scroll position, all tabs
    - Interactive elements: buttons, links, input fields (with text/href)
    - Content: headings, images (count only - not URLs), forms, tables
    - State: alerts, modals, loading indicators

    Use when you need:
    - Page structure understanding
    - Check what tabs are open
    - Find available buttons/links/inputs
    - Detect modals or loading states

    Note: Shows image count, not URLs. For DOM attributes (img src, link href),
    you'll need to add a dedicated tool using Playwright's page.evaluate().

    Returns JSON (no screenshot).
    """
    try:
        # Get session_id from ToolContext
        session_id = tool_context.invocation_state.get("session_id")
        if not session_id and hasattr(tool_context.agent, '_session_manager'):
            session_id = tool_context.agent._session_manager.session_id
            logger.info(f"[browser_get_page_info] Using session_id from agent._session_manager: {session_id}")
        elif session_id:
            logger.info(f"[browser_get_page_info] Using session_id from invocation_state: {session_id}")
        else:
            raise ValueError("session_id not found in ToolContext")

        controller = get_or_create_controller(session_id)
        result = controller.get_page_info()

        if result["status"] == "success":
            import json

            # Format the structured data
            page_data = {
                "page": result["page"],
                "interactive": result["interactive"],
                "content": result["content"],
                "state": result["state"],
                "navigation": result["navigation"]
            }

            page_data_str = json.dumps(page_data, indent=2, ensure_ascii=False)

            # Build summary text
            page = result["page"]
            interactive = result["interactive"]
            content = result["content"]
            state = result["state"]

            summary_lines = []
            summary_lines.append(f"**URL**: {page['url']}")
            summary_lines.append(f"**Title**: {page['title']}")
            summary_lines.append(f"**Scroll**: {page['scroll']['percentage']}% ({page['scroll']['current']}/{page['scroll']['max']}px)")
            summary_lines.append("")

            # Interactive summary
            summary_lines.append(f"**Interactive Elements**:")
            summary_lines.append(f"- Buttons: {len(interactive['buttons'])} visible")
            summary_lines.append(f"- Links: {len(interactive['links'])} visible")
            summary_lines.append(f"- Inputs: {len(interactive['inputs'])} fields")
            summary_lines.append("")

            # Content summary
            summary_lines.append(f"**Content**:")
            summary_lines.append(f"- Headings: {len(content['headings'])}")
            summary_lines.append(f"- Images: {content['image_count']}")
            summary_lines.append(f"- Has form: {'Yes' if content['has_form'] else 'No'}")
            summary_lines.append(f"- Has table: {'Yes' if content['has_table'] else 'No'}")

            # State warnings
            if state['has_alerts']:
                summary_lines.append("")
                summary_lines.append(f"⚠️ **Alerts detected**: {len(state['alert_messages'])}")
            if state['has_modals']:
                summary_lines.append(f"⚠️ **Modal is open**")
            if state['has_loading']:
                summary_lines.append(f"⏳ **Page is loading**")

            # Add detailed tab information
            tabs = result.get('tabs', [])
            if tabs:
                summary_lines.append("")
                tab_details = _format_tab_list_detailed(tabs)
                summary_lines.append(tab_details)

            summary = "\n".join(summary_lines)

            content = [{
                "text": f"""✅ **Page information collected**

{summary}

**Full Details**:
```json
{page_data_str}
```"""
            }]

            # Get browser session info for Live View
            # Note: URL generation moved to BFF for on-demand refresh capability
            metadata = {}
            if controller.browser_session_client and controller.browser_session_client.session_id:
                metadata["browserSessionId"] = controller.browser_session_client.session_id
                if controller.browser_id:
                    metadata["browserId"] = controller.browser_id

            return {
                "content": content,
                "status": "success",
                "metadata": metadata
            }
        else:
            return {
                "content": [{
                    "text": f"❌ **Failed to get page info**\n\n{result.get('message', 'Unknown error')}"
                }],
                "status": "error"
            }

    except Exception as e:
        logger.error(f"browser_get_page_info failed: {e}")
        return {
            "content": [{
                "text": f"❌ **Error getting page info**: {str(e)}"
            }],
            "status": "error"
        }


@tool(context=True)
def browser_manage_tabs(
    action: str,
    tab_index: Optional[int] = None,
    url: Optional[str] = None,
    tool_context: ToolContext = None
) -> Dict[str, Any]:
    """
    Manage browser tabs - switch between tabs, close a tab, or create a new tab.

    NOTE: To VIEW all open tabs, use browser_get_page_info() instead.
    This tool is for ACTIONS only (switch/close/create).

    Args:
        action: Action to perform on tabs
            - "switch": Switch to the tab at tab_index (makes it the active tab)
            - "close": Close the tab at tab_index
            - "create": Create a new tab and navigate to url

        tab_index: Tab index (0-based). Required for "switch" and "close" actions.
                   Use -1 for the last tab. Ignored for "create" action.

        url: URL to open in new tab. Required for "create" action.
             If not provided for "create", opens about:blank.

    Examples:
        - Switch to first tab: browser_manage_tabs(action="switch", tab_index=0)
        - Switch to last tab: browser_manage_tabs(action="switch", tab_index=-1)
        - Close second tab: browser_manage_tabs(action="close", tab_index=1)
        - Create new tab: browser_manage_tabs(action="create", url="https://google.com")

    Returns screenshot of the current active tab after the action.
    """
    try:
        # Get session_id from ToolContext
        session_id = tool_context.invocation_state.get("session_id")
        if not session_id and hasattr(tool_context.agent, '_session_manager'):
            session_id = tool_context.agent._session_manager.session_id
            logger.info(f"[browser_manage_tabs] Using session_id from agent._session_manager: {session_id}")
        elif session_id:
            logger.info(f"[browser_manage_tabs] Using session_id from invocation_state: {session_id}")
        else:
            raise ValueError("session_id not found in ToolContext")

        controller = get_or_create_controller(session_id)

        # Validate action
        valid_actions = ["switch", "close", "create"]
        if action not in valid_actions:
            return {
                "content": [{
                    "text": f"❌ **Invalid action**: '{action}'. Must be one of: {', '.join(valid_actions)}\n\n💡 **Tip**: To view all tabs, use browser_get_page_info() instead."
                }],
                "status": "error"
            }

        # Handle each action
        if action == "switch":
            if tab_index is None:
                return {
                    "content": [{
                        "text": "❌ **tab_index required** for 'switch' action. Example: browser_manage_tabs(action='switch', tab_index=0)"
                    }],
                    "status": "error"
                }

            result = controller.switch_tab(tab_index)

            if result["status"] == "success":
                tab_details = _format_tab_list_detailed(result.get('tabs', []))

                content = [{
                    "text": f"""✅ **Switched to tab {result.get('current_tab', tab_index)}**

**URL**: {result.get('current_url', 'N/A')}
**Title**: {result.get('page_title', 'N/A')}

{tab_details}

Current tab screenshot shown below."""
                }]

                if result.get("screenshot"):
                    content.append({
                        "image": {
                            "format": "jpeg",
                            "source": {"bytes": result["screenshot"]}
                        }
                    })

                metadata = {}
                if controller.browser_session_client and controller.browser_session_client.session_id:
                    metadata["browserSessionId"] = controller.browser_session_client.session_id
                    if controller.browser_id:
                        metadata["browserId"] = controller.browser_id

                return {
                    "content": content,
                    "status": "success",
                    "metadata": metadata
                }
            else:
                return {
                    "content": [{
                        "text": f"❌ **Switch failed**: {result.get('message', 'Unknown error')}"
                    }],
                    "status": "error"
                }

        elif action == "close":
            if tab_index is None:
                return {
                    "content": [{
                        "text": "❌ **tab_index required** for 'close' action. Example: browser_manage_tabs(action='close', tab_index=1)"
                    }],
                    "status": "error"
                }

            result = controller.close_tab(tab_index)

            if result["status"] == "success":
                tab_details = _format_tab_list_detailed(result.get('tabs', []))

                content = [{
                    "text": f"""✅ **Tab closed**

{result.get('message', 'Tab closed successfully')}

**Now on tab {result.get('current_tab', 0)}**:
**URL**: {result.get('current_url', 'N/A')}
**Title**: {result.get('page_title', 'N/A')}

{tab_details}

Current tab screenshot shown below."""
                }]

                if result.get("screenshot"):
                    content.append({
                        "image": {
                            "format": "jpeg",
                            "source": {"bytes": result["screenshot"]}
                        }
                    })

                metadata = {}
                if controller.browser_session_client and controller.browser_session_client.session_id:
                    metadata["browserSessionId"] = controller.browser_session_client.session_id
                    if controller.browser_id:
                        metadata["browserId"] = controller.browser_id

                return {
                    "content": content,
                    "status": "success",
                    "metadata": metadata
                }
            else:
                return {
                    "content": [{
                        "text": f"❌ **Close failed**: {result.get('message', 'Unknown error')}"
                    }],
                    "status": "error"
                }

        elif action == "create":
            # URL is optional, defaults to about:blank
            create_url = url or "about:blank"

            result = controller.create_tab(create_url)

            if result["status"] == "success":
                tab_details = _format_tab_list_detailed(result.get('tabs', []))

                content = [{
                    "text": f"""✅ **New tab created**

{result.get('message', 'Tab created successfully')}

**Now on tab {result.get('current_tab', 0)}**:
**URL**: {result.get('current_url', 'N/A')}
**Title**: {result.get('page_title', 'N/A')}

{tab_details}

Current tab screenshot shown below."""
                }]

                if result.get("screenshot"):
                    content.append({
                        "image": {
                            "format": "jpeg",
                            "source": {"bytes": result["screenshot"]}
                        }
                    })

                metadata = {}
                if controller.browser_session_client and controller.browser_session_client.session_id:
                    metadata["browserSessionId"] = controller.browser_session_client.session_id
                    if controller.browser_id:
                        metadata["browserId"] = controller.browser_id

                return {
                    "content": content,
                    "status": "success",
                    "metadata": metadata
                }
            else:
                return {
                    "content": [{
                        "text": f"❌ **Create failed**: {result.get('message', 'Unknown error')}"
                    }],
                    "status": "error"
                }

    except Exception as e:
        logger.error(f"browser_manage_tabs failed: {e}")
        return {
            "content": [{
                "text": f"❌ **Tab management error**: {str(e)}"
            }],
            "status": "error"
        }


@tool(context=True)
def browser_drag(
    start_x: int,
    start_y: int,
    end_x: int,
    end_y: int,
    steps: int = 10,
    include_screenshot: bool = False,
    tool_context: ToolContext = None
) -> Dict[str, Any]:
    """
    Drag from start coordinates to end coordinates using Playwright.
    Useful for drawing, resizing elements, moving objects, or slider controls.

    Args:
        start_x: X coordinate to start drag (pixels from left edge of viewport)
        start_y: Y coordinate to start drag (pixels from top edge of viewport)
        end_x: X coordinate to end drag (pixels from left edge of viewport)
        end_y: Y coordinate to end drag (pixels from top edge of viewport)
        steps: Number of intermediate points for smooth movement (default: 10)
        include_screenshot: Whether to include screenshot in response (default: False, saves ~1s)

    Tip: Use browser_get_page_info() first to understand page dimensions and viewport size.
    Set include_screenshot=True when you need to verify the result visually.
    """
    try:
        # Get session_id from ToolContext
        session_id = tool_context.invocation_state.get("session_id")
        if not session_id and hasattr(tool_context.agent, '_session_manager'):
            session_id = tool_context.agent._session_manager.session_id
            logger.info(f"[browser_drag] Using session_id from agent._session_manager: {session_id}")
        elif session_id:
            logger.info(f"[browser_drag] Using session_id from invocation_state: {session_id}")
        else:
            raise ValueError("session_id not found in ToolContext")

        controller = get_or_create_controller(session_id)

        # Ensure browser is connected
        if not controller._connected:
            controller.connect()

        # Get the current page
        page = controller._get_current_page()
        if not page:
            return {
                "content": [{
                    "text": "❌ **Drag failed**: No active browser page"
                }],
                "status": "error"
            }

        logger.info(f"Dragging from ({start_x}, {start_y}) to ({end_x}, {end_y}) with {steps} steps")

        # Perform drag using Playwright's mouse API
        page.mouse.move(start_x, start_y)
        page.mouse.down()
        page.mouse.move(end_x, end_y, steps=steps)
        page.mouse.up()

        # Get current page info
        current_url = page.url
        page_title = page.title()

        # Format tab summary if multiple tabs
        tab_summary = _format_tab_summary(
            controller.get_tab_list(),
            controller._current_tab_index
        )
        tab_line = f"\n{tab_summary}" if tab_summary else ""

        content = [{
            "text": f"""✅ **Drag completed**

**From**: ({start_x}, {start_y})
**To**: ({end_x}, {end_y})
**Steps**: {steps}
**Current URL**: {current_url}
**Page Title**: {page_title}{tab_line}"""
        }]

        # Only take screenshot if requested
        if include_screenshot:
            screenshot_data = controller._take_screenshot()
            if screenshot_data:
                content[0]["text"] += "\n\nScreenshot captured below."
                content.append({
                    "image": {
                        "format": "jpeg",
                        "source": {
                            "bytes": screenshot_data  # Raw bytes
                        }
                    }
                })

        # Get browser session info for Live View
        metadata = {}
        if controller.browser_session_client and controller.browser_session_client.session_id:
            metadata["browserSessionId"] = controller.browser_session_client.session_id
            if controller.browser_id:
                metadata["browserId"] = controller.browser_id

        return {
            "content": content,
            "status": "success",
            "metadata": metadata
        }

    except Exception as e:
        logger.error(f"browser_drag failed: {e}")
        return {
            "content": [{
                "text": f"❌ **Drag error**: {str(e)}"
            }],
            "status": "error"
        }


@tool(context=True)
def browser_save_screenshot(filename: str, tool_context: ToolContext) -> Dict[str, Any]:
    """
    Save current browser screenshot to workspace for use in documents/reports.

    IMPORTANT: Browser screenshots are NOT automatically saved. Other browser tools
    (navigate, act, etc.) only display screenshots in chat - they don't persist them.
    You MUST call this tool to save a screenshot to workspace.

    When to use:
    - User wants to include browser screenshots in Word/PowerPoint documents
    - User asks to "capture" or "save" what's on the browser screen
    - Creating visual evidence or documentation of web pages

    Args:
        filename: Image filename (e.g., "search-results.png", "product-page.jpg")
                 Must end with .png, .jpg, or .jpeg

    Returns text confirmation with saved location. The saved image can then be
    referenced by filename in document tools (Word, Excel, PowerPoint).
    """
    try:
        # Validate filename
        if not filename.lower().endswith(('.png', '.jpg', '.jpeg')):
            return {
                "content": [{
                    "text": "❌ **Invalid filename**: Must end with .png, .jpg, or .jpeg"
                }],
                "status": "error"
            }

        # Get session_id from ToolContext
        session_id = tool_context.invocation_state.get("session_id")
        if not session_id and hasattr(tool_context.agent, '_session_manager'):
            session_id = tool_context.agent._session_manager.session_id
            logger.info(f"[browser_save_screenshot] Using session_id from agent._session_manager: {session_id}")
        elif session_id:
            logger.info(f"[browser_save_screenshot] Using session_id from invocation_state: {session_id}")
        else:
            raise ValueError("session_id not found in ToolContext")

        # Get user_id (from environment or agent config)
        user_id = os.environ.get('USER_ID', 'default_user')

        # Get current browser controller
        controller = get_or_create_controller(session_id)

        # Ensure browser is connected
        if not controller._connected:
            controller.connect()

        # Get current page info for context
        page_info = controller.get_page_info()
        if page_info.get("status") != "success":
            return {
                "content": [{
                    "text": "❌ **Failed to capture screenshot**: Browser not ready"
                }],
                "status": "error"
            }

        # Take screenshot using controller's method
        screenshot_bytes = controller._take_screenshot()

        if not screenshot_bytes:
            return {
                "content": [{
                    "text": "❌ **No screenshot data available**"
                }],
                "status": "error"
            }

        # Save to workspace using ImageManager
        from workspace import ImageManager

        image_manager = ImageManager(user_id=user_id, session_id=session_id)
        image_manager.save_to_s3(filename, screenshot_bytes)

        # Get current page info for context
        current_url = page_info.get("page", {}).get("url", "Unknown")
        current_title = page_info.get("page", {}).get("title", "Untitled")

        return {
            "content": [{
                "text": f"""✅ **Screenshot saved to workspace**

**Filename**: {filename}
**Source**: {current_title}
**URL**: {current_url}

This image is now available in workspace and can be referenced by filename in document tools."""
            }],
            "status": "success"
        }

    except Exception as e:
        logger.error(f"browser_save_screenshot failed: {e}")
        return {
            "content": [{
                "text": f"❌ **Screenshot save error**: {str(e)}"
            }],
            "status": "error"
        }
