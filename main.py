import os
import sys
import types
from datetime import datetime
import time
import cv2
import pandas as pd

# --- THE BYPASS (DO NOT CHANGE) ---
MODEL_DIR = r"C:/Users/dell/AppData/Roaming/Python/Python314/site-packages/face_recognition/models"
os.environ['FACE_RECOGNITION_MODELS_PATH'] = MODEL_DIR
m = types.ModuleType("face_recognition_models")
m.pose_predictor_model_location = lambda: os.path.join(MODEL_DIR, "shape_predictor_68_face_landmarks.dat")
m.pose_predictor_five_point_model_location = lambda: os.path.join(MODEL_DIR, "shape_predictor_5_face_landmarks.dat")
m.face_recognition_model_location = lambda: os.path.join(MODEL_DIR, "dlib_face_recognition_resnet_model_v1.dat")
m.cnn_face_detector_model_location = lambda: os.path.join(MODEL_DIR, "mmod_human_face_detector.dat")
sys.modules["face_recognition_models"] = m

import face_recognition # Imported after the bypass

# --- MULTI-USER DATABASE (WITH DETAILS) ---
# Yahan aap kisi ki bhi detail add kar sakte hain
TEACHERS_DB = {
    "Ubada Hussain": {
        "image": "ubada.jpg", 
        "id": "FA24-BSCS-001", 
        "dept": "BSCS-1A"
    },
    "Ali Raza": {
        "image": "ali.jpg", 
        "id": "FA24-BSCS-002", 
        "dept": "BSCS-1A"
    }
}

LOG_FILE = "Teacher_Detailed_Attendance.xlsx"
COOLDOWN_SECONDS = 15 # Ek action ke baad kitni der system wait kare (seconds)

# State Tracker: Har banday ka current status yaad rakhne ke liye
attendance_state = {} 

def log_attendance(name, action, duration="N/A"):
    details = TEACHERS_DB[name]
    now = datetime.now()
    
    # Naya aur behtar Excel Format
    df = pd.DataFrame([{
        'Date': now.strftime("%Y-%m-%d"),
        'Time': now.strftime("%H:%M:%S"),
        'Teacher ID': details["id"],
        'Name': name,
        'Department': details["dept"],
        'Action': action,
        'Session Duration': duration
    }])
    
    if not os.path.exists(LOG_FILE):
        df.to_excel(LOG_FILE, index=False)
    else:
        with pd.ExcelWriter(LOG_FILE, mode='a', engine='openpyxl', if_sheet_exists='overlay') as writer:
            old = pd.read_excel(LOG_FILE)
            pd.concat([old, df], ignore_index=True).to_excel(writer, index=False)

# --- INITIALIZE MULTI-FACE ENCODINGS ---
known_encodings = []
known_names = []

print("LOG: System Initializing... Loading Authorized Faces.")
for name, data in TEACHERS_DB.items():
    img_file = data["image"]
    if os.path.exists(img_file):
        img = face_recognition.load_image_file(img_file)
        enc = face_recognition.face_encodings(img)[0]
        known_encodings.append(enc)
        known_names.append(name)
        
        # Har banday ka initial state OUT set kar rahe hain
        attendance_state[name] = {"status": "OUT", "last_scan_time": 0.0, "in_time": None}
    else:
        print(f"Warning: Photo '{img_file}' missing for {name}.")

# --- EXECUTION ---
try:
    cap = cv2.VideoCapture(0)
    print("LOG: Camera Live. Processing started...")

    process_this_frame = True # Frame Skipping toggle
    face_locations = []
    face_encodings = []
    face_names = []

    while True:
        ret, frame = cap.read()
        if not ret: break

        # --- FRAME SKIPPING LOGIC (For Zero Lag) ---
        # Har doosre frame par processing hogi, jis se speed double ho jayegi
        if process_this_frame:
            small_frame = cv2.resize(frame, (0, 0), fx=0.25, fy=0.25)
            rgb_small_frame = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)
            
            face_locations = face_recognition.face_locations(rgb_small_frame)
            face_encodings = face_recognition.face_encodings(rgb_small_frame, face_locations)

            face_names = []
            for face_enc in face_encodings:
                matches = face_recognition.compare_faces(known_encodings, face_enc, tolerance=0.5)
                name = "Unknown"

                if True in matches:
                    first_match_index = matches.index(True)
                    name = known_names[first_match_index]
                    
                    # --- SMART IN/OUT LOGIC ---
                    current_time = time.time()
                    user_state = attendance_state[name]
                    
                    # Agar cooldown time guzar chuka hai
                    if (current_time - user_state["last_scan_time"]) > COOLDOWN_SECONDS:
                        
                        if user_state["status"] == "OUT":
                            # Banda pehli dafa aaya hai
                            user_state["status"] = "IN"
                            user_state["in_time"] = datetime.now()
                            log_attendance(name, "IN")
                            print(f"\n[ENTRY] {name} entered the class.")
                            
                        else:
                            # Banda waqt guzarne ke baad dobara scan hua (matlab ja raha hai)
                            user_state["status"] = "OUT"
                            duration_obj = datetime.now() - user_state["in_time"]
                            duration_str = str(duration_obj).split(".")[0] # Sirf H:M:S nikalne ke liye
                            
                            log_attendance(name, "OUT", duration=duration_str)
                            print(f"\n[EXIT] {name} left. Total Stay: {duration_str}")
                            
                            user_state["in_time"] = None # Reset time
                            
                        user_state["last_scan_time"] = current_time # Update scan time
                
                face_names.append(name)

        # Toggle for next frame
        process_this_frame = not process_this_frame

        # --- DRAWING BOXES ON FRAME ---
        for (top, right, bottom, left), name in zip(face_locations, face_names):
            top *= 4
            right *= 4
            bottom *= 4
            left *= 4

            if name == "Unknown":
                color = (0, 0, 255) # Red
                display_text = "Unknown"
            else:
                color = (0, 255, 0) # Green
                status = attendance_state[name]["status"]
                display_text = f"{name} ({status})"

            cv2.rectangle(frame, (left, top), (right, bottom), color, 2)
            
            # Text background taake easily parha ja sake
            cv2.rectangle(frame, (left, bottom - 35), (right, bottom), color, cv2.FILLED)
            font = cv2.FONT_HERSHEY_DUPLEX
            cv2.putText(frame, display_text, (left + 6, bottom - 6), font, 0.6, (255, 255, 255), 1)

        cv2.imshow("Teacher Monitor System", frame)
        if cv2.waitKey(1) & 0xFF == ord('q'): break
    
    cap.release()
    cv2.destroyAllWindows()

except Exception as e:
    print(f"System Error: {e}")