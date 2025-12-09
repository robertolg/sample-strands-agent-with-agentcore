"""
Test script for chart generation in Research Agent

Tests the generate_chart_tool independently
"""
import os
import sys
from pathlib import Path

# Add src to path
src_path = Path(__file__).parent / "src"
sys.path.insert(0, str(src_path))

# Set environment variables for testing (only if not already set)
os.environ.setdefault('AWS_REGION', 'us-west-2')
os.environ.setdefault('PROJECT_NAME', 'strands-agent-chatbot')
os.environ.setdefault('ENVIRONMENT', 'dev')
os.environ.setdefault('SESSION_ID', 'test-session-123')
# IMPORTANT: Set your chart storage bucket
os.environ.setdefault('CHART_STORAGE_BUCKET', 'your-chart-bucket-name-here')  # TODO: Change this

# Test chart generation without Code Interpreter (mock test)
def test_report_manager_s3_upload():
    """Test that ReportManager can upload charts to S3"""
    from report_manager import get_report_manager
    import base64

    # Create a simple 1x1 pixel PNG for testing
    # PNG header + IDAT chunk for 1x1 transparent pixel
    test_png = base64.b64decode(
        b'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    )

    session_id = "test-session-123"
    user_id = "test-user-456"
    manager = get_report_manager(session_id, user_id)

    print(f"Testing chart upload for user: {user_id}, session: {session_id}")
    print(f"Workspace: {manager.workspace}")

    # Test save_chart with S3 upload
    result = manager.save_chart("test_chart", test_png)

    print("\nResult:")
    print(f"  Local path: {result['local_path']}")
    print(f"  S3 key: {result['s3_key']}")

    if result['s3_key']:
        print("\n✅ SUCCESS: Chart uploaded to S3!")
        print(f"   S3 URI: {result['s3_key']}")
    else:
        print("\n❌ FAILED: S3 upload failed")
        print("   Check:")
        print("   1. CHART_STORAGE_BUCKET environment variable is set")
        print("   2. AWS credentials are configured")
        print("   3. Bucket exists and you have write permissions")

if __name__ == "__main__":
    print("=" * 60)
    print("Research Agent Chart Generation Test")
    print("=" * 60)
    print()

    # Check environment
    chart_bucket = os.getenv('CHART_STORAGE_BUCKET')
    if not chart_bucket or chart_bucket == 'your-chart-bucket-name-here':
        print("⚠️  WARNING: CHART_STORAGE_BUCKET not configured")
        print("   Please set it to your S3 bucket name")
        print()
        print("Example:")
        print("  export CHART_STORAGE_BUCKET='my-research-charts-bucket'")
        print()
        sys.exit(1)

    print(f"Chart Storage Bucket: {chart_bucket}")
    print()

    try:
        test_report_manager_s3_upload()
    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
