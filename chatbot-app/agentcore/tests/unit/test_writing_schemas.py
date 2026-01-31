"""Tests for Writing Agent Schemas"""

import pytest
from datetime import datetime, timezone

from models.writing_schemas import (
    WritingTaskStatus,
    WritingWorkflowStatus,
    FormatPreference,
    StructurePreference,
    WritingRequirements,
    OutlineSection,
    OutlineSubsection,
    DocumentOutline,
    OutlineConfirmation,
    SectionContent,
    BodyWriteProgress,
    IntroOutroContent,
    ReviewResult,
    WritingWorkflowState,
    WritingProgressEvent,
    WritingOutlineEvent,
    WritingCompleteEvent,
    WritingStartRequest,
    WritingConfirmRequest,
    WritingStateResponse,
)


class TestStatusEnums:
    """Test status enum values"""

    def test_writing_task_status_values(self):
        """Test WritingTaskStatus enum has expected values"""
        assert WritingTaskStatus.PENDING == "pending"
        assert WritingTaskStatus.IN_PROGRESS == "in_progress"
        assert WritingTaskStatus.AWAITING_CONFIRMATION == "awaiting_confirmation"
        assert WritingTaskStatus.COMPLETED == "completed"
        assert WritingTaskStatus.FAILED == "failed"

    def test_writing_workflow_status_values(self):
        """Test WritingWorkflowStatus enum has expected values"""
        assert WritingWorkflowStatus.NOT_STARTED == "not_started"
        assert WritingWorkflowStatus.IN_PROGRESS == "in_progress"
        assert WritingWorkflowStatus.AWAITING_OUTLINE_CONFIRMATION == "awaiting_outline_confirmation"
        assert WritingWorkflowStatus.COMPLETED == "completed"
        assert WritingWorkflowStatus.CANCELLED == "cancelled"
        assert WritingWorkflowStatus.FAILED == "failed"

    def test_format_preference_values(self):
        """Test FormatPreference enum has expected values"""
        assert FormatPreference.MARKDOWN == "markdown"
        assert FormatPreference.PLAIN_TEXT == "plain_text"
        assert FormatPreference.MINIMAL == "minimal"

    def test_structure_preference_values(self):
        """Test StructurePreference enum has expected values"""
        assert StructurePreference.PROSE == "prose"
        assert StructurePreference.BULLET_POINTS == "bullet_points"
        assert StructurePreference.MIXED == "mixed"


class TestWritingRequirements:
    """Test WritingRequirements schema"""

    def test_minimal_requirements(self):
        """Test creating requirements with minimal fields"""
        req = WritingRequirements(
            document_type="report",
            topic="AI in Healthcare"
        )
        assert req.document_type == "report"
        assert req.topic == "AI in Healthcare"
        assert req.target_audience == "general"  # default
        assert req.tone == "professional"  # default
        assert req.length_guidance == "medium"  # default
        assert req.key_points == []
        assert req.constraints == []
        assert req.format_preference == FormatPreference.MARKDOWN  # default
        assert req.structure_preference == StructurePreference.PROSE  # default

    def test_full_requirements(self):
        """Test creating requirements with all fields"""
        req = WritingRequirements(
            document_type="proposal",
            topic="Cloud Migration Strategy",
            target_audience="executive",
            tone="formal",
            length_guidance="long",
            key_points=["Cost savings", "Timeline", "Risks"],
            constraints=["Must include ROI analysis"],
            format_preference=FormatPreference.MINIMAL,
            structure_preference=StructurePreference.MIXED
        )
        assert req.document_type == "proposal"
        assert req.target_audience == "executive"
        assert len(req.key_points) == 3
        assert len(req.constraints) == 1
        assert req.format_preference == FormatPreference.MINIMAL
        assert req.structure_preference == StructurePreference.MIXED

    def test_requirements_serialization(self):
        """Test requirements can be serialized to dict"""
        req = WritingRequirements(
            document_type="article",
            topic="Machine Learning Basics"
        )
        data = req.model_dump()
        assert isinstance(data, dict)
        assert data["document_type"] == "article"
        assert data["format_preference"] == "markdown"
        assert data["structure_preference"] == "prose"


class TestDocumentOutline:
    """Test DocumentOutline and related schemas"""

    def test_outline_section(self):
        """Test OutlineSection creation"""
        section = OutlineSection(
            title="Introduction",
            description="Overview of the topic",
            estimated_words=200
        )
        assert section.title == "Introduction"
        assert section.description == "Overview of the topic"
        assert section.estimated_words == 200
        assert len(section.section_id) > 0  # auto-generated

    def test_outline_with_subsections(self):
        """Test OutlineSection with subsections"""
        subsection = OutlineSubsection(
            title="Background",
            description="Historical context"
        )
        section = OutlineSection(
            title="Introduction",
            description="Overview",
            subsections=[subsection]
        )
        assert len(section.subsections) == 1
        assert section.subsections[0].title == "Background"

    def test_document_outline(self):
        """Test DocumentOutline creation"""
        sections = [
            OutlineSection(title="Introduction", description="Overview"),
            OutlineSection(title="Main Content", description="Core discussion"),
            OutlineSection(title="Conclusion", description="Summary")
        ]
        outline = DocumentOutline(
            title="Test Document",
            sections=sections,
            total_estimated_words=1000
        )
        assert outline.title == "Test Document"
        assert len(outline.sections) == 3
        assert outline.total_estimated_words == 1000
        assert outline.version == 1

    def test_outline_version_increment(self):
        """Test outline version can be incremented"""
        outline = DocumentOutline(
            title="Test",
            sections=[],
            version=2
        )
        assert outline.version == 2


class TestOutlineConfirmation:
    """Test OutlineConfirmation schema"""

    def test_approval(self):
        """Test approved confirmation"""
        conf = OutlineConfirmation(approved=True)
        assert conf.approved is True
        assert conf.feedback is None
        assert conf.specific_changes == []

    def test_rejection_with_feedback(self):
        """Test rejected confirmation with feedback"""
        conf = OutlineConfirmation(
            approved=False,
            feedback="Please add more sections on security",
            specific_changes=["Add security section", "Expand introduction"]
        )
        assert conf.approved is False
        assert "security" in conf.feedback
        assert len(conf.specific_changes) == 2


class TestBodyWriteProgress:
    """Test BodyWriteProgress schema"""

    def test_initial_progress(self):
        """Test initial progress state"""
        progress = BodyWriteProgress(total_sections=5)
        assert progress.total_sections == 5
        assert progress.completed_sections == 0
        assert progress.current_section_id is None
        assert progress.sections_content == []

    def test_progress_with_content(self):
        """Test progress with completed sections"""
        section1 = SectionContent(
            section_id="s1",
            title="Introduction",
            content="This is the introduction...",
            word_count=150,
            status=WritingTaskStatus.COMPLETED
        )
        progress = BodyWriteProgress(
            total_sections=3,
            completed_sections=1,
            current_section_id="s2",
            sections_content=[section1]
        )
        assert progress.completed_sections == 1
        assert progress.current_section_id == "s2"
        assert len(progress.sections_content) == 1
        assert progress.sections_content[0].word_count == 150


class TestWritingWorkflowState:
    """Test WritingWorkflowState schema"""

    def test_default_state(self):
        """Test default workflow state"""
        state = WritingWorkflowState()
        assert state.status == WritingWorkflowStatus.NOT_STARTED
        assert state.current_task == 0
        assert state.user_request == ""
        assert state.requirements is None
        assert state.outline is None
        assert state.outline_attempts == 0
        assert state.max_outline_attempts == 3

    def test_state_with_requirements(self):
        """Test state with requirements set"""
        req = WritingRequirements(
            document_type="report",
            topic="Test Topic"
        )
        state = WritingWorkflowState(
            status=WritingWorkflowStatus.IN_PROGRESS,
            current_task=2,
            user_request="Write a report about test topic",
            requirements=req
        )
        assert state.status == WritingWorkflowStatus.IN_PROGRESS
        assert state.current_task == 2
        assert state.requirements.topic == "Test Topic"

    def test_state_serialization(self):
        """Test state can be serialized to dict"""
        state = WritingWorkflowState(
            status=WritingWorkflowStatus.IN_PROGRESS,
            current_task=1
        )
        data = state.to_dict()
        assert isinstance(data, dict)
        assert data["status"] == "in_progress"
        assert data["current_task"] == 1

    def test_state_deserialization(self):
        """Test state can be deserialized from dict"""
        data = {
            "workflow_id": "test-123",
            "status": "in_progress",
            "current_task": 2,
            "user_request": "Write a report",
            "outline_attempts": 1
        }
        state = WritingWorkflowState.from_dict(data)
        assert state.workflow_id == "test-123"
        assert state.status == WritingWorkflowStatus.IN_PROGRESS
        assert state.current_task == 2
        assert state.outline_attempts == 1

    def test_state_from_none(self):
        """Test state creation from None returns default"""
        state = WritingWorkflowState.from_dict(None)
        assert state.status == WritingWorkflowStatus.NOT_STARTED

    def test_full_workflow_state(self):
        """Test complete workflow state"""
        req = WritingRequirements(
            document_type="article",
            topic="AI Ethics"
        )
        outline = DocumentOutline(
            title="AI Ethics in Modern Society",
            sections=[
                OutlineSection(title="Intro", description="Opening"),
                OutlineSection(title="Main", description="Discussion")
            ],
            total_estimated_words=1500
        )
        body = BodyWriteProgress(
            total_sections=2,
            completed_sections=2,
            sections_content=[
                SectionContent(
                    section_id="s1",
                    title="Intro",
                    content="Content here",
                    word_count=300
                ),
                SectionContent(
                    section_id="s2",
                    title="Main",
                    content="More content",
                    word_count=800
                )
            ]
        )
        intro_outro = IntroOutroContent(
            introduction="Welcome to this article...",
            conclusion="In conclusion..."
        )
        review = ReviewResult(
            final_document="Full document text...",
            total_word_count=1500,
            changes_made=["Fixed grammar", "Improved flow"]
        )

        state = WritingWorkflowState(
            status=WritingWorkflowStatus.COMPLETED,
            current_task=6,
            user_request="Write about AI ethics",
            requirements=req,
            outline=outline,
            body_progress=body,
            intro_outro=intro_outro,
            review_result=review
        )

        # Test serialization round-trip
        data = state.to_dict()
        restored = WritingWorkflowState.from_dict(data)

        assert restored.status == WritingWorkflowStatus.COMPLETED
        assert restored.requirements.topic == "AI Ethics"
        assert restored.outline.title == "AI Ethics in Modern Society"
        assert len(restored.body_progress.sections_content) == 2
        assert restored.review_result.total_word_count == 1500


class TestSSEEvents:
    """Test SSE event schemas"""

    def test_progress_event(self):
        """Test WritingProgressEvent"""
        event = WritingProgressEvent(
            task=2,
            task_name="Outline Generation",
            status=WritingTaskStatus.IN_PROGRESS,
            details="Creating document structure"
        )
        assert event.type == "writing_progress"
        assert event.task == 2
        assert event.task_name == "Outline Generation"
        assert event.status == WritingTaskStatus.IN_PROGRESS

    def test_outline_event(self):
        """Test WritingOutlineEvent"""
        outline = DocumentOutline(
            title="Test",
            sections=[OutlineSection(title="Section 1", description="Desc")]
        )
        event = WritingOutlineEvent(
            outline=outline,
            attempt=1
        )
        assert event.type == "writing_outline"
        assert event.outline.title == "Test"
        assert event.attempt == 1

    def test_complete_event(self):
        """Test WritingCompleteEvent"""
        event = WritingCompleteEvent(
            document_title="My Document",
            word_count=2500,
            sections_count=5
        )
        assert event.type == "writing_complete"
        assert event.document_title == "My Document"
        assert event.word_count == 2500
        assert event.sections_count == 5


class TestAPIModels:
    """Test API request/response models"""

    def test_start_request_minimal(self):
        """Test WritingStartRequest with minimal fields"""
        req = WritingStartRequest(
            session_id="sess-123",
            message="Write a blog post about Python"
        )
        assert req.session_id == "sess-123"
        assert req.message == "Write a blog post about Python"
        assert req.user_id is None
        assert req.model_id is None

    def test_start_request_full(self):
        """Test WritingStartRequest with all fields"""
        req = WritingStartRequest(
            session_id="sess-123",
            user_id="user-456",
            message="Write a technical report",
            model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
            temperature=0.5
        )
        assert req.user_id == "user-456"
        assert req.model_id == "us.anthropic.claude-sonnet-4-20250514-v1:0"
        assert req.temperature == 0.5

    def test_confirm_request_approved(self):
        """Test WritingConfirmRequest for approval"""
        req = WritingConfirmRequest(
            session_id="sess-123",
            approved=True
        )
        assert req.approved is True
        assert req.feedback is None

    def test_confirm_request_rejected(self):
        """Test WritingConfirmRequest for rejection"""
        req = WritingConfirmRequest(
            session_id="sess-123",
            approved=False,
            feedback="Add more details",
            specific_changes=["Expand section 2", "Add examples"]
        )
        assert req.approved is False
        assert req.feedback == "Add more details"
        assert len(req.specific_changes) == 2

    def test_state_response(self):
        """Test WritingStateResponse"""
        outline = DocumentOutline(title="Test", sections=[])
        resp = WritingStateResponse(
            status=WritingWorkflowStatus.AWAITING_OUTLINE_CONFIRMATION,
            current_task=3,
            outline=outline
        )
        assert resp.status == WritingWorkflowStatus.AWAITING_OUTLINE_CONFIRMATION
        assert resp.current_task == 3
        assert resp.outline is not None


class TestStateTransitions:
    """Test state transition patterns"""

    def test_workflow_progress_through_tasks(self):
        """Test workflow progresses through all tasks"""
        state = WritingWorkflowState()

        # Task 1
        state.status = WritingWorkflowStatus.IN_PROGRESS
        state.current_task = 1
        assert state.status == WritingWorkflowStatus.IN_PROGRESS

        # Task 2
        state.current_task = 2
        assert state.current_task == 2

        # Task 3 - await confirmation
        state.current_task = 3
        state.status = WritingWorkflowStatus.AWAITING_OUTLINE_CONFIRMATION
        assert state.status == WritingWorkflowStatus.AWAITING_OUTLINE_CONFIRMATION

        # Resume after confirmation
        state.status = WritingWorkflowStatus.IN_PROGRESS
        state.current_task = 4
        assert state.current_task == 4

        # Tasks 5-6
        state.current_task = 5
        state.current_task = 6
        state.status = WritingWorkflowStatus.COMPLETED
        assert state.status == WritingWorkflowStatus.COMPLETED

    def test_outline_revision_attempts(self):
        """Test outline revision tracking"""
        state = WritingWorkflowState()

        # First attempt
        state.outline_attempts = 1
        assert state.outline_attempts < state.max_outline_attempts

        # Second attempt with feedback
        state.outline_feedback.append("Add more sections")
        state.outline_attempts = 2
        assert len(state.outline_feedback) == 1

        # Third attempt (max)
        state.outline_feedback.append("Expand introduction")
        state.outline_attempts = 3
        assert state.outline_attempts >= state.max_outline_attempts

    def test_failure_state(self):
        """Test workflow failure state"""
        state = WritingWorkflowState(
            status=WritingWorkflowStatus.IN_PROGRESS,
            current_task=2
        )

        # Simulate failure
        state.status = WritingWorkflowStatus.FAILED
        state.error_message = "LLM invocation failed"

        assert state.status == WritingWorkflowStatus.FAILED
        assert state.error_message is not None
