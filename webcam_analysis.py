# Installation:
# pip install opencv-python google-generativeai pillow

import cv2
import google.generativeai as genai
import time
import threading
import json
import os
from PIL import Image
import io

# --- CONFIGURATION ---
API_KEY = os.environ.get('API_KEY')
MODEL_NAME = "gemini-1.5-flash"
CHECK_INTERVAL = 4 # Seconds between API analysis
CONSECUTIVE_EMPTY_LIMIT = 2 # How many empty checks before resetting dwell time

# Initialize Gemini
genai.configure(api_key=API_KEY)
model = genai.GenerativeModel(MODEL_NAME)

# --- GLOBAL STATE ---
state = {
    "people_count": 0,
    "people": [],
    "dwell_time_start": None,
    "accumulated_dwell_time": 0,
    "is_processing": False,
    "empty_count": 0,
    "last_json": {}
}

PROMPT = """
Analyze this webcam frame and return EXACTLY a JSON object with this structure:
{
  "people_count": integer,
  "people": [
    {
      "gender": string,
      "approximate_age": integer,
      "movement_type": string (short description of physical action)
    }
  ]
}
Do not include any markdown formatting or extra text.
"""

def analyze_frame(frame):
    global state
    state["is_processing"] = True
    
    try:
        # Convert OpenCV BGR to RGB PIL Image
        img_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        pil_img = Image.fromarray(img_rgb)
        
        # Call Gemini
        response = model.generate_content([PROMPT, pil_img])
        
        # Clean up JSON string (remove ```json ... ``` blocks if present)
        raw_text = response.text.strip()
        if raw_text.startswith("```json"):
            raw_text = raw_text.split("```json")[1].split("```")[0].strip()
        elif raw_text.startswith("```"):
            raw_text = raw_text.split("```")[1].split("```")[0].strip()
            
        data = json.loads(raw_text)
        
        # Update State
        count = data.get("people_count", 0)
        state["people_count"] = count
        state["people"] = data.get("people", [])
        state["last_json"] = data
        
        # Dwell Time Logic
        if count > 0:
            state["empty_count"] = 0
            if state["dwell_time_start"] is None:
                state["dwell_time_start"] = time.time()
        else:
            state["empty_count"] += 1
            if state["empty_count"] >= CONSECUTIVE_EMPTY_LIMIT:
                state["dwell_time_start"] = None
                state["accumulated_dwell_time"] = 0
                
        # Console Output
        print("\n--- GEMINI ANALYSIS ---")
        print(json.dumps(data, indent=2))
        if state["dwell_time_start"]:
            current_dwell = time.time() - state["dwell_time_start"]
            print(f"Accumulated Dwell Time: {current_dwell:.2f}s")
        else:
            print("Accumulated Dwell Time: 0s (No people detected)")

    except Exception as e:
        print(f"API Error: {e}")
    finally:
        state["is_processing"] = False

def main():
    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        print("Error: Could not open webcam.")
        return

    last_check_time = 0
    print(f"Started monitoring with {MODEL_NAME}. Press 'q' to exit.")

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        current_time = time.time()
        
        # Interval check (Asynchronous)
        if (current_time - last_check_time) > CHECK_INTERVAL and not state["is_processing"]:
            last_check_time = current_time
            # Start analysis in a separate thread to keep feed smooth
            threading.Thread(target=analyze_frame, args=(frame.copy(),), daemon=True).start()

        # UI Overlay (Minimal)
        dwell_val = 0
        if state["dwell_time_start"]:
            dwell_val = time.time() - state["dwell_time_start"]
            
        cv2.putText(frame, f"People: {state['people_count']}", (20, 40), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
        cv2.putText(frame, f"Dwell Time: {dwell_val:.1f}s", (20, 70), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
        if state["is_processing"]:
            cv2.putText(frame, "Analyzing...", (20, 100), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1)

        # Show feed
        cv2.imshow("Gemini Real-Time Analysis", frame)

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()
