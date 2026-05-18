import os
import sys
import types
from datetime import datetime, timedelta
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

# --- MULTI-USER SETTINGS ---
# To add more people: Put their photo in the folder and add to this list
PEOPLE = {
    "Ali Raza": "ali.jpg",
    "Ubada Hussain": "ubada.jpg"
}

LOG_FILE = "attendance.xlsx"
tracker = {}  # Stores: {Name: Entry_Time}
cooldown = {} # To prevent IN/OUT spamming

def log_attendance(name, status, duration="N/A"):
    now = datetime.now()
    df = pd.DataFrame([{
        'Name': name, 'Status': status, 
        'Date': now.strftime("%Y-%m-%d"),
        'Time': now.strftime("%H:%M:%S"), 
        'Duration': duration
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

print("LOG: Loading Authorized Faces...")
for name, img_file in PEOPLE.items():
    if os.path.exists(img_file):
        img = face_recognition.load_image_file(img_file)
        enc = face_recognition.face_encodings(img)[0]
        known_encodings.append(enc)
        known_names.append(name)
    else:
        print(f"Warning: Photo for {name} missing. Skipping.")

# --- EXECUTION ---
try:
    cap = cv2.VideoCapture(0)
    print("LOG: System Live. Press 'q' to quit.")

    while True:
        ret, frame = cap.read()
        if not ret: break

        # Process frame
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        face_locs = face_recognition.face_locations(rgb_frame)
        face_encs = face_recognition.face_encodings(rgb_frame, face_locs)

        for (top, right, bottom, left), face_enc in zip(face_locs, face_encs):
            matches = face_recognition.compare_faces(known_encodings, face_enc)
            name = "Unknown"

            if True in matches:
                first_match_index = matches.index(True)
                name = known_names[first_match_index]
                now = datetime.now()

                # --- ANTI-SPAM LOGIC ---
                # 1. If not in tracker, log them IN
                if name not in tracker:
                    tracker[name] = now
                    log_attendance(name, "IN")
                    print(f"WELCOME: {name}")
                    cooldown[name] = now + timedelta(seconds=10) # Set 10 second "Stay" period
                
                # 2. If already IN, check if enough time has passed to log them OUT
                else:
                    if now > cooldown[name]:
                        start_time = tracker.pop(name)
                        duration = str(now - start_time).split(".")[0]
                        log_attendance(name, "OUT", duration)
                        print(f"GOODBYE: {name}. Stayed: {duration}")
                        # Avoid logging them back IN for at least 5 seconds
                        cv2.waitKey(2000) 

            # Draw Box & Name
            cv2.rectangle(frame, (left, top), (right, bottom), (0, 255, 0), 2)
            cv2.putText(frame, name, (left, top - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        cv2.imshow("CA Multi-User Attendance System", frame)
        if cv2.waitKey(1) & 0xFF == ord('q'): break
    
    cap.release()
    cv2.destroyAllWindows()

except Exception as e:
    print(f"System Error: {e}")