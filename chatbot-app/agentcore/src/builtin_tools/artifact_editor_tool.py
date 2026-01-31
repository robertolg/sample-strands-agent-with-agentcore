"""
Artifact Editor Tool - Update existing artifacts

This tool allows the agent to modify existing artifacts (documents, markdown, etc.)
when the user requests changes to previously created content.

Uses agent.state (Strands SDK native state management) to read and update artifacts.
Uses find & replace approach for targeted edits.
"""

from strands import tool, ToolContext
from typing import Dict, Any
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


@tool(
    context=True,
    description=(
        "Update the currently selected artifact using find-and-replace. "
        "Use this when user asks to modify specific parts like 'change X to Y', "
        "'merge those two paragraphs', 'make this section shorter', etc. "
        "The artifact is automatically selected - you don't need to specify which one."
    )
)
def update_artifact(
    find_text: str,
    replace_text: str,
    tool_context: ToolContext
) -> dict:
    """
    Find and replace text in the currently selected artifact.

    Args:
        find_text: The exact text to find in the artifact (can be multiple paragraphs)
        replace_text: The text to replace it with
        tool_context: Tool execution context (automatically provided)

    Returns:
        Dictionary with update confirmation
    """
    try:
        # Get selected artifact_id from invocation_state
        invocation_state = tool_context.invocation_state or {}
        artifact_id = invocation_state.get("selected_artifact_id")

        if not artifact_id:
            return {
                "content": [{
                    "text": "No artifact is currently selected. Please select an artifact first."
                }],
                "status": "error"
            }

        logger.info(f"Update artifact request: {artifact_id}")
        logger.debug(f"Finding: {find_text[:100]}...")
        logger.debug(f"Replacing with: {replace_text[:100]}...")

        # Access agent.state through ToolContext
        agent = tool_context.agent

        # Get current artifacts from agent.state
        artifacts = agent.state.get("artifacts") or {}

        # Check if artifact exists
        if artifact_id not in artifacts:
            return {
                "content": [{
                    "text": f"Artifact not found: {artifact_id}"
                }],
                "status": "error"
            }

        # Get current content
        artifact = artifacts[artifact_id]
        current_content = artifact["content"]

        # Perform find & replace
        if find_text not in current_content:
            return {
                "content": [{
                    "text": (
                        f"Could not find the specified text in the artifact.\n\n"
                        f"**Looking for:** {find_text[:200]}...\n\n"
                        f"Please check the text and try again with the exact wording."
                    )
                }],
                "status": "error"
            }

        # Replace the text
        updated_content = current_content.replace(find_text, replace_text, 1)

        # Update word count
        word_count = len(updated_content.split())

        # Update the artifact
        artifact["content"] = updated_content
        artifact["metadata"]["word_count"] = word_count
        artifact["updated_at"] = datetime.now(timezone.utc).isoformat()

        # Save back to agent.state
        agent.state.set("artifacts", artifacts)

        # Sync agent state to file system / AgentCore Memory
        # Get session_id and user_id from invocation_state
        session_id = invocation_state.get("session_id")
        user_id = invocation_state.get("user_id")

        if session_id:
            try:
                from agent.factory import create_session_manager
                session_manager = create_session_manager(
                    session_id=session_id,
                    user_id=user_id or session_id,
                    mode="text",
                    compaction_enabled=False,
                    use_buffer=False  # No buffer needed for sync
                )
                session_manager.sync_agent(
                    session_id=session_id,
                    agent=agent
                )
                logger.info(f"Agent state synced for artifact update: {artifact_id}")
            except Exception as sync_error:
                logger.warning(f"Failed to sync agent state: {sync_error}")

        logger.info(f"Artifact updated successfully: {artifact_id}")
        return {
            "content": [{
                "text": (
                    f"Updated successfully!\n\n"
                    f"**Word count:** {word_count}\n\n"
                    f"The changes have been saved."
                )
            }],
            "status": "success"
        }

    except Exception as e:
        logger.error(f"Error updating artifact: {e}", exc_info=True)
        return {
            "content": [{
                "text": f"Error updating artifact: {str(e)}"
            }],
            "status": "error"
        }
