import pytest
import json
from unittest.mock import patch, MagicMock
import numpy as np
import time

from webcam_analysis import analyze_frame, state

@pytest.fixture(autouse=True)
def reset_state():
    """Reset the global state before each test."""
    global state
    state["people_count"] = 0
    state["people"] = []
    state["dwell_time_start"] = None
    state["accumulated_dwell_time"] = 0
    state["is_processing"] = False
    state["empty_count"] = 0
    state["last_json"] = {}
    yield

def test_analyze_frame_json_parse_error(capsys):
    """Test that a JSON parsing error is caught and state is managed properly."""
    frame = np.zeros((100, 100, 3), dtype=np.uint8)

    with patch('webcam_analysis.model.generate_content') as mock_generate:
        mock_response = MagicMock()
        mock_response.text = "This is not valid JSON"
        mock_generate.return_value = mock_response

        analyze_frame(frame)

        # Assert exception is printed
        captured = capsys.readouterr()
        assert "API Error" in captured.out

        # Assert state is uncorrupted
        assert state["is_processing"] is False
        assert state["people_count"] == 0
        assert state["last_json"] == {}

def test_analyze_frame_valid_json():
    """Test the happy path with valid JSON."""
    frame = np.zeros((100, 100, 3), dtype=np.uint8)

    valid_json = {
        "people_count": 1,
        "people": [
            {
                "gender": "male",
                "approximate_age": 30,
                "movement_type": "standing"
            }
        ]
    }

    with patch('webcam_analysis.model.generate_content') as mock_generate:
        mock_response = MagicMock()
        mock_response.text = json.dumps(valid_json)
        mock_generate.return_value = mock_response

        analyze_frame(frame)

        assert state["is_processing"] is False
        assert state["people_count"] == 1
        assert state["people"][0]["gender"] == "male"
        assert state["last_json"] == valid_json
        assert state["dwell_time_start"] is not None
        assert state["empty_count"] == 0

def test_analyze_frame_empty_json():
    """Test with valid JSON but zero people."""
    frame = np.zeros((100, 100, 3), dtype=np.uint8)

    empty_json = {
        "people_count": 0,
        "people": []
    }

    with patch('webcam_analysis.model.generate_content') as mock_generate:
        mock_response = MagicMock()
        mock_response.text = json.dumps(empty_json)
        mock_generate.return_value = mock_response

        # Need to set dwell_time_start to something to verify empty logic
        state["dwell_time_start"] = time.time()

        analyze_frame(frame)

        assert state["is_processing"] is False
        assert state["people_count"] == 0
        assert state["empty_count"] == 1

        # Call it enough times to trigger reset
        analyze_frame(frame) # empty count = 2

        assert state["empty_count"] == 2
        assert state["dwell_time_start"] is None

def test_analyze_frame_markdown_json():
    """Test valid JSON wrapped in markdown."""
    frame = np.zeros((100, 100, 3), dtype=np.uint8)

    valid_json = {
        "people_count": 2,
        "people": []
    }

    markdown_text = f"```json\n{json.dumps(valid_json)}\n```"

    with patch('webcam_analysis.model.generate_content') as mock_generate:
        mock_response = MagicMock()
        mock_response.text = markdown_text
        mock_generate.return_value = mock_response

        analyze_frame(frame)

        assert state["is_processing"] is False
        assert state["people_count"] == 2
