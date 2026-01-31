#!/usr/bin/env python3
"""
Test script for Composer Workflow - Direct Module Test

Usage:
    cd chatbot-app/agentcore
    python ../../scripts/test_composer.py

This script:
1. Directly imports and instantiates ComposerWorkflow
2. Calls run_workflow with a sample writing request
3. Displays SSE events in real-time
4. Auto-approves outline and continues to completion
"""

import sys
import os
import asyncio
import json
import uuid

# Add agentcore to Python path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'chatbot-app', 'agentcore', 'src'))

from workflows.composer_workflow import ComposerWorkflow
from models.writing_schemas import OutlineConfirmation

# Configuration
SESSION_ID = f"test-{uuid.uuid4().hex[:8]}"
USER_ID = "test-user"

# Sample writing request
WRITING_REQUEST = """Write a short article about the benefits of pair programming for software development teams.
Target audience: engineering managers and team leads.
Tone: professional but approachable.
Length: around 500 words.
Include practical examples and actionable insights."""


def format_event(event_data: dict) -> str:
    """Format event data for display"""
    event_type = event_data.get("type", "unknown")

    if event_type == "start":
        return "🚀 Workflow started"

    elif event_type == "writing_progress":
        task = event_data.get("task", "?")
        task_name = event_data.get("task_name", "")
        status = event_data.get("status", "")
        details = event_data.get("details", "")
        return f"📋 Task {task}: {task_name} [{status}]\n   {details}"

    elif event_type == "writing_outline":
        outline = event_data.get("outline", {})
        title = outline.get("title", "Untitled")
        sections = outline.get("sections", [])
        attempt = event_data.get("attempt", 1)

        result = f"\n📝 OUTLINE GENERATED (Attempt {attempt})\n"
        result += f"   Title: {title}\n"
        result += f"   Total words: ~{outline.get('total_estimated_words', 0)}\n"
        result += f"   Sections ({len(sections)}):\n"
        for i, section in enumerate(sections, 1):
            result += f"     {i}. {section.get('title', 'Untitled Section')}\n"
            result += f"        {section.get('description', '')}\n"
            result += f"        (~{section.get('estimated_words', 0)} words)\n"
            subsections = section.get('subsections', [])
            if subsections:
                for sub in subsections:
                    result += f"          • {sub.get('title', 'Untitled Subsection')}\n"
        return result

    elif event_type == "interrupt":
        interrupts = event_data.get("interrupts", [])
        if interrupts:
            reason = interrupts[0].get("reason", "Workflow paused")
            return f"\n⏸️  WORKFLOW PAUSED\n   {reason}"
        return "\n⏸️  WORKFLOW PAUSED - Waiting for confirmation"

    elif event_type == "writing_section_complete":
        section_id = event_data.get("section_id", "?")
        title = event_data.get("title", "")
        word_count = event_data.get("word_count", 0)
        return f"✅ Section '{title}' completed ({word_count} words)"

    elif event_type == "writing_complete":
        title = event_data.get("document_title", "Untitled")
        word_count = event_data.get("word_count", 0)
        sections_count = event_data.get("sections_count", 0)
        return f"\n🎉 DOCUMENT COMPLETED\n   Title: {title}\n   Words: {word_count}\n   Sections: {sections_count}"

    elif event_type == "error":
        message = event_data.get("message", "Unknown error")
        return f"❌ ERROR: {message}"

    elif event_type == "text":
        content = event_data.get("content", "")
        return f"💬 {content}"

    elif event_type == "end":
        return "🏁 Stream ended"

    else:
        # Don't print raw JSON for unknown types, just show type
        return f"📦 {event_type}"


def parse_sse_line(line: str) -> dict | None:
    """Parse SSE line and return event data"""
    if line.startswith("data: "):
        data_str = line[6:].strip()
        if data_str and data_str != "[DONE]":
            try:
                return json.loads(data_str)
            except json.JSONDecodeError:
                print(f"⚠️  Failed to parse: {data_str}")
    return None


async def start_writing():
    """Start writing workflow"""
    print(f"\n{'='*60}")
    print(f"Starting Writing Workflow")
    print(f"{'='*60}")
    print(f"Session ID: {SESSION_ID}")
    print(f"User ID: {USER_ID}")
    print(f"Request: {WRITING_REQUEST[:100]}...")
    print(f"{'='*60}\n")

    # Create ComposerWorkflow directly
    workflow = ComposerWorkflow(
        session_id=SESSION_ID,
        user_id=USER_ID,
        model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
        temperature=0.7
    )

    outline_data = None
    generator = None

    # Stream events
    try:
        generator = workflow.run_workflow(user_request=WRITING_REQUEST)
        async for sse_line in generator:
            event_data = parse_sse_line(sse_line)

            if event_data:
                print(format_event(event_data))

                # Capture outline for confirmation
                if event_data.get("type") == "writing_outline":
                    outline_data = event_data.get("outline")

                # If interrupt, return outline for confirmation
                if event_data.get("type") == "interrupt":
                    break
    except Exception as e:
        print(f"⚠️  Error during workflow: {e}")
    finally:
        # Properly close the generator
        if generator is not None:
            try:
                await generator.aclose()
            except:
                pass

    return outline_data


async def confirm_outline(outline: dict, approved: bool = True, feedback: str = None):
    """Confirm or reject outline"""
    print(f"\n{'='*60}")
    print(f"Confirming Outline: {'✅ APPROVED' if approved else '❌ REJECTED'}")
    print(f"{'='*60}\n")

    # Create ComposerWorkflow (loads existing state)
    workflow = ComposerWorkflow(
        session_id=SESSION_ID,
        user_id=USER_ID
    )

    # Create confirmation object
    confirmation = OutlineConfirmation(
        approved=approved,
        feedback=feedback
    )

    # Collect document text
    document_parts = []
    generator = None

    # Stream remaining events
    try:
        generator = workflow.run_workflow(confirmation_response=confirmation)
        async for sse_line in generator:
            event_data = parse_sse_line(sse_line)

            if event_data:
                # Collect text content
                if event_data.get("type") == "text":
                    content = event_data.get("content", "")
                    document_parts.append(content)

                print(format_event(event_data))
    except Exception as e:
        print(f"⚠️  Error during confirmation: {e}")
    finally:
        # Properly close the generator
        if generator is not None:
            try:
                await generator.aclose()
            except:
                pass

    # Print final assembled document
    if document_parts:
        final_document = "".join(document_parts)
        print(f"\n{'='*60}")
        print(f"FINAL DOCUMENT")
        print(f"{'='*60}\n")
        print(final_document)
        print(f"\n{'='*60}\n")


async def main_async():
    """Main test flow"""
    try:
        # Start workflow
        outline = await start_writing()

        if not outline:
            print("\n⚠️  No outline received, workflow may have completed without interrupt")
            return

        # Auto-approve outline for testing
        print("\n⏳ Auto-approving outline in 2 seconds...")
        await asyncio.sleep(2)

        await confirm_outline(outline, approved=True)

        print(f"\n{'='*60}")
        print(f"✅ Test completed successfully!")
        print(f"{'='*60}\n")

    except KeyboardInterrupt:
        print("\n\n⚠️  Interrupted by user")
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        import traceback
        traceback.print_exc()


def main():
    """Entry point"""
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
