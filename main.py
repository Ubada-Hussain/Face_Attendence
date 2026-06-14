import os
import sys
import types
from datetime import datetime
import time
import cv2
import pandas as pd
import serial

MODEL_DIR = r"C:/Users/dell/AppData/Roaming/Python/Python314/site-packages/face_recognition/models"
os.environ['FACE_RECOGNITION_MODELS_PATH'] = MODEL_DIR
m = types.ModuleType("face_recognition_models")
m.pose_predictor_model_location = lambda: os.path.join(MODEL_DIR, "shape_predictor_68_face_landmarks.dat")
m.pose_predictor_five_point_model_location = lambda: os.path.join(MODEL_DIR, "shape_predictor_5_face_landmarks.dat")
m.face_recognition_model_location = lambda: os.path.join(MODEL_DIR, "dlib_face_recognition_resnet_model_v1.dat")
m.cnn_face_detector_model_location = lambda: os.path.join(MODEL_DIR, "mmod_human_face_detector.dat")
sys.modules["face_recognition_models"] = m

import face_recognition

try:
    arduino = serial.Serial('COM4', 9600, timeout=1)
    time.sleep(2)
except Exception:
    arduino = None

TEACHERS_DB = {
    "Ubada Hussain": {
        "image": "ubada.jpg", 
        "id": "FA24-BSCS-001", 
        "dept": "BSCS-1A",
        "uid": "6D 3C 18 07"
    },
    "Ali Raza": {
        "image": "ali.jpg", 
        "id": "FA24-BSCS-002", 
        "dept": "BSCS-1A",
        "uid": "PUT_ALI_UID_HERE"
    },
    "Ustad Gggg": {
        "image": "soban.jpg", 
        "id": "FA24-BSCS-003", 
        "dept": "BSCS-1A",
        "uid": "PUT_SOBAN_UID_HERE"
    }
}

LOG_FILE = "Teacher_Detailed_Attendance.xlsx"

attendance_state = {} 

def log_attendance(name, action, duration="N/A"):
    details = TEACHERS_DB[name]
    now = datetime.now()
    
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

known_encodings = []
known_names = []

for name, data in TEACHERS_DB.items():
    img_file = data["image"]
    if os.path.exists(img_file):
        img = face_recognition.load_image_file(img_file)
        enc = face_recognition.face_encodings(img)[0]
        known_encodings.append(enc)
        known_names.append(name)
        
        attendance_state[name] = {"status": "OUT", "in_time": None}
try:
    cap = cv2.VideoCapture(0)

    # --- NAYI LOGIC YAHAN HAI ---
    frame_count = 0
    PROCESS_EVERY_N_FRAMES = 5  # Har 5 frames ke baad scan karega (Speed badhane ke liye isay 7 ya 10 bhi kar sakte ho)

    face_locations = []
    face_encodings = []
    face_names = []

    while True:
        ret, frame = cap.read()
        if not ret: break

        # Arduino se RFID sunne wala code waisa hi rahega
        if arduino and arduino.in_waiting > 0:
            try:
                msg = arduino.readline().decode('utf-8').strip()
                if msg.startswith("UID:"):
                    scanned_uid = msg.split(":")[1].strip()
                    user_found = False
                    
                    for db_name, db_data in TEACHERS_DB.items():
                        if db_data.get("uid") == scanned_uid:
                            user_found = True
                            user_state = attendance_state[db_name]
                            
                            if user_state["status"] == "IN":
                                user_state["status"] = "OUT"
                                if user_state["in_time"]:
                                    duration_obj = datetime.now() - user_state["in_time"]
                                    duration_str = str(duration_obj).split(".")[0]
                                else:
                                    duration_str = "N/A"
                                    
                                log_attendance(db_name, "OUT", duration=duration_str)
                                print(f"\n[EXIT] {db_name} left via RFID. Stay: {duration_str}")
                                user_state["in_time"] = None
                            else:
                                print(f"\n[INFO] {db_name} scanned RFID, but was not marked IN.")
                            break
                            
                    if not user_found:
                        print(f"\n[UNREGISTERED RFID SCAN] UID: {scanned_uid}")
            except Exception:
                pass

        # --- SMART FRAME SKIPPING ---
        if frame_count % PROCESS_EVERY_N_FRAMES == 0:
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
                    
                    user_state = attendance_state[name]
                    
                    if user_state["status"] == "OUT":
                        user_state["status"] = "IN"
                        user_state["in_time"] = datetime.now()
                        log_attendance(name, "IN")
                        print(f"\n[ENTRY] {name} entered via Camera.")
                        
                        if arduino:
                            arduino.write(b'OPEN\n')
                
                face_names.append(name)

        # Counter ko agay barhao
        frame_count += 1

        # Boxes draw karne wala hissa
        for (top, right, bottom, left), name in zip(face_locations, face_names):
            top *= 4
            right *= 4
            bottom *= 4
            left *= 4

            if name == "Unknown":
                color = (0, 0, 255)
                display_text = "Unknown"
            else:
                color = (0, 255, 0)
                status = attendance_state[name]["status"]
                display_text = f"{name} ({status})"

            cv2.rectangle(frame, (left, top), (right, bottom), color, 2)
            
            font = cv2.FONT_HERSHEY_DUPLEX
            cv2.putText(frame, display_text, (left, top - 10), font, 0.6, color, 1)

        cv2.imshow("Teacher Monitor System", frame)
        if cv2.waitKey(1) & 0xFF == ord('q'): break
    
    cap.release()
    cv2.destroyAllWindows()
    
    if arduino:
        arduino.close()

except Exception as e:
    print(e)