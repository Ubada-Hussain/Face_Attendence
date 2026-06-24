import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import cron from 'node-cron';
import nodemailer from 'nodemailer';

const app = express();
const server = http.createServer(app);
const allowedOrigins = [
  process.env.CLIENT_ORIGIN || 'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:5174'
];
const io = new Server(server, {
  cors: { origin: allowedOrigins }
});

const PORT = Number(process.env.PORT || 5050);
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/ca_attendance_parking';
const TOTAL_PARKING_SLOTS = Number(process.env.TOTAL_PARKING_SLOTS || 5);
const MIN_WEEKLY_HOURS = Number(process.env.MIN_WEEKLY_HOURS || 20);

app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '1mb' }));

const teacherSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    teacherId: { type: String, required: true, unique: true },
    dept: { type: String, required: true },
    uid: { type: String, required: true, unique: true },
    image: String,
    status: { type: String, enum: ['IN', 'OUT'], default: 'OUT' },
    currentAttendanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Attendance', default: null },
    currentSlot: { type: Number, default: null },
    lastSeenAt: Date
  },
  { timestamps: true }
);

const attendanceSchema = new mongoose.Schema(
  {
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
    name: String,
    teacherId: String,
    dept: String,
    uid: String,
    entryAt: { type: Date, required: true },
    exitAt: Date,
    durationMinutes: { type: Number, default: 0 },
    entrySource: { type: String, default: 'CAMERA' },
    exitSource: String,
    slotNumber: Number
  },
  { timestamps: true }
);

const parkingSlotSchema = new mongoose.Schema(
  {
    slotNumber: { type: Number, required: true, unique: true },
    occupied: { type: Boolean, default: false },
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', default: null },
    occupiedSince: Date
  },
  { timestamps: true }
);

const notificationSchema = new mongoose.Schema(
  {
    teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher' },
    type: { type: String, required: true },
    message: { type: String, required: true },
    weekStart: Date,
    weekEnd: Date,
    sent: { type: Boolean, default: false },
    sentAt: Date
  },
  { timestamps: true }
);

const Teacher = mongoose.model('Teacher', teacherSchema);
const Attendance = mongoose.model('Attendance', attendanceSchema);
const ParkingSlot = mongoose.model('ParkingSlot', parkingSlotSchema);
const Notification = mongoose.model('Notification', notificationSchema);

const seedTeachers = [
  { name: 'Ubada Hussain', teacherId: 'FA24-BSCS-001', dept: 'BSCS-1A', uid: '6D 3C 18 07', image: 'ubada.jpg' },
  { name: 'Ali Raza', teacherId: 'FA24-BSCS-002', dept: 'BSCS-1A', uid: '79 D0 0F 9E', image: 'ali.jpg' },
  { name: 'Ustad Gggg', teacherId: 'FA24-BSCS-003', dept: 'BSCS-1A', uid: '61 5E 0F 9E', image: 'soban.jpg' },
  { name: 'Salman', teacherId: 'FA24-BSCS-004', dept: 'BSCS-1A', uid: 'AB CD 12 34', image: 'salman.jpg' }
];

async function seedDatabase() {
  for (const teacher of seedTeachers) {
    await Teacher.updateOne({ teacherId: teacher.teacherId }, { $setOnInsert: teacher }, { upsert: true });
  }

  for (let slotNumber = 1; slotNumber <= TOTAL_PARKING_SLOTS; slotNumber += 1) {
    await ParkingSlot.updateOne({ slotNumber }, { $setOnInsert: { slotNumber } }, { upsert: true });
  }
}

function startOfWeek(date = new Date()) {
  const result = new Date(date);
  const day = result.getDay();
  const diff = result.getDate() - day + (day === 0 ? -6 : 1);
  result.setDate(diff);
  result.setHours(0, 0, 0, 0);
  return result;
}

function endOfWeek(date = new Date()) {
  const result = startOfWeek(date);
  result.setDate(result.getDate() + 7);
  return result;
}

function minutesBetween(start, end) {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

async function getDashboardData() {
  const [teachers, parkingSlots, recentAttendance, alerts] = await Promise.all([
    Teacher.find().sort({ name: 1 }).lean(),
    ParkingSlot.find().populate('teacher', 'name teacherId dept').sort({ slotNumber: 1 }).lean(),
    Attendance.find().sort({ entryAt: -1 }).limit(15).lean(),
    Notification.find().sort({ createdAt: -1 }).limit(10).lean()
  ]);

  const activeCount = teachers.filter((teacher) => teacher.status === 'IN').length;
  const freeSlots = parkingSlots.filter((slot) => !slot.occupied).length;

  return { teachers, parkingSlots, recentAttendance, alerts, totals: { activeCount, freeSlots, totalSlots: parkingSlots.length } };
}

async function emitDashboard() {
  io.emit('dashboard:update', await getDashboardData());
}

async function findTeacher(payload) {
  const uid = payload.uid?.trim();
  if (uid) {
    const teacher = await Teacher.findOne({ uid });
    if (teacher) return teacher;
  }

  if (payload.teacherId) {
    const teacher = await Teacher.findOne({ teacherId: payload.teacherId });
    if (teacher) return teacher;
  }

  if (payload.name) {
    return Teacher.findOne({ name: payload.name });
  }

  return null;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'attendance-parking-api' });
});

app.get('/api/dashboard', async (_req, res, next) => {
  try {
    res.json(await getDashboardData());
  } catch (error) {
    next(error);
  }
});

app.post('/api/access/entry', async (req, res, next) => {
  try {
    const teacher = await findTeacher(req.body);
    if (!teacher) {
      return res.status(404).json({ allowed: false, message: 'Teacher not registered' });
    }

    teacher.lastSeenAt = new Date();

    if (teacher.status === 'IN' && teacher.currentAttendanceId) {
      await teacher.save();
      return res.json({ allowed: true, openGate: false, message: 'Already marked IN', teacher });
    }

    const freeSlot = await ParkingSlot.findOne({ occupied: false }).sort({ slotNumber: 1 });
    if (!freeSlot) {
      await teacher.save();
      await emitDashboard();
      return res.status(409).json({ allowed: false, openGate: false, message: 'No parking slot available', teacher });
    }

    const now = new Date();
    const attendance = await Attendance.create({
      teacher: teacher._id,
      name: teacher.name,
      teacherId: teacher.teacherId,
      dept: teacher.dept,
      uid: teacher.uid,
      entryAt: now,
      entrySource: req.body.source || 'CAMERA',
      slotNumber: freeSlot.slotNumber
    });

    freeSlot.occupied = true;
    freeSlot.teacher = teacher._id;
    freeSlot.occupiedSince = now;
    await freeSlot.save();

    teacher.status = 'IN';
    teacher.currentAttendanceId = attendance._id;
    teacher.currentSlot = freeSlot.slotNumber;
    await teacher.save();

    await emitDashboard();
    return res.json({ allowed: true, openGate: true, message: 'Entry marked', teacher, slotNumber: freeSlot.slotNumber });
  } catch (error) {
    next(error);
  }
});

app.post('/api/access/exit', async (req, res, next) => {
  try {
    const teacher = await findTeacher(req.body);
    if (!teacher) {
      return res.status(404).json({ allowed: false, message: 'Teacher not registered' });
    }

    teacher.lastSeenAt = new Date();
    if (teacher.status !== 'IN' || !teacher.currentAttendanceId) {
      await teacher.save();
      return res.json({ allowed: true, openGate: false, message: 'Teacher was not IN', teacher });
    }

    const now = new Date();
    const attendance = await Attendance.findById(teacher.currentAttendanceId);
    if (attendance) {
      attendance.exitAt = now;
      attendance.exitSource = req.body.source || 'RFID';
      attendance.durationMinutes = minutesBetween(attendance.entryAt, now);
      await attendance.save();
    }

    if (teacher.currentSlot) {
      await ParkingSlot.updateOne(
        { slotNumber: teacher.currentSlot },
        { $set: { occupied: false, teacher: null, occupiedSince: null } }
      );
    }

    teacher.status = 'OUT';
    teacher.currentAttendanceId = null;
    teacher.currentSlot = null;
    await teacher.save();

    await emitDashboard();
    return res.json({
      allowed: true,
      openGate: true,
      message: 'Exit marked',
      teacher,
      durationMinutes: attendance?.durationMinutes || 0
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/reset-system', async (_req, res, next) => {
  try {
    const now = new Date();
    const activeTeachers = await Teacher.find({ status: 'IN', currentAttendanceId: { $ne: null } });

    for (const teacher of activeTeachers) {
      const attendance = await Attendance.findById(teacher.currentAttendanceId);
      if (attendance && !attendance.exitAt) {
        attendance.exitAt = now;
        attendance.exitSource = 'MANUAL_RESET';
        attendance.durationMinutes = minutesBetween(attendance.entryAt, now);
        await attendance.save();
      }
    }

    await Teacher.updateMany(
      {},
      { $set: { status: 'OUT', currentAttendanceId: null, currentSlot: null, lastSeenAt: now } }
    );
    await ParkingSlot.updateMany(
      {},
      { $set: { occupied: false, teacher: null, occupiedSince: null } }
    );

    await emitDashboard();
    res.json({ ok: true, message: 'System reset. All teachers are OUT and all slots are free.' });
  } catch (error) {
    next(error);
  }
});

app.get('/api/reports/weekly', async (req, res, next) => {
  try {
    const weekStart = req.query.start ? new Date(req.query.start) : startOfWeek();
    const weekEnd = req.query.end ? new Date(req.query.end) : endOfWeek(weekStart);
    const teachers = await Teacher.find().sort({ name: 1 }).lean();
    const rows = [];

    for (const teacher of teachers) {
      const records = await Attendance.find({
        teacher: teacher._id,
        entryAt: { $gte: weekStart, $lt: weekEnd }
      }).lean();

      const totalMinutes = records.reduce((sum, record) => {
        if (record.exitAt) return sum + (record.durationMinutes || 0);
        return sum + minutesBetween(record.entryAt, new Date());
      }, 0);

      rows.push({
        teacher,
        totalMinutes,
        totalHours: Math.round((totalMinutes / 60) * 100) / 100,
        sessions: records.length,
        belowRequired: totalMinutes / 60 < MIN_WEEKLY_HOURS
      });
    }

    res.json({ weekStart, weekEnd, minimumHours: MIN_WEEKLY_HOURS, rows });
  } catch (error) {
    next(error);
  }
});

async function sendAdminAlert(reportRow, weekStart, weekEnd) {
  const message = `${reportRow.teacher.name} weekly hours are ${reportRow.totalHours}, below required ${MIN_WEEKLY_HOURS}.`;
  const notification = await Notification.create({
    teacher: reportRow.teacher._id,
    type: 'LOW_WEEKLY_HOURS',
    message,
    weekStart,
    weekEnd
  });

  if (process.env.EMAIL_HOST && process.env.ADMIN_EMAIL) {
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_PORT || 587),
      secure: false,
      auth: process.env.EMAIL_USER ? { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } : undefined
    });

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: process.env.ADMIN_EMAIL,
      subject: 'Low weekly working hours alert',
      text: message
    });

    notification.sent = true;
    notification.sentAt = new Date();
    await notification.save();
  }

  return notification;
}

app.post('/api/reports/weekly/check-alerts', async (_req, res, next) => {
  try {
    const weekStart = startOfWeek();
    const weekEnd = endOfWeek();
    const reportResponse = await fetch(`http://127.0.0.1:${PORT}/api/reports/weekly`);
    const report = await reportResponse.json();
    const created = [];

    for (const row of report.rows.filter((item) => item.belowRequired)) {
      const exists = await Notification.findOne({ teacher: row.teacher._id, type: 'LOW_WEEKLY_HOURS', weekStart });
      if (!exists) {
        created.push(await sendAdminAlert(row, weekStart, weekEnd));
      }
    }

    await emitDashboard();
    res.json({ created });
  } catch (error) {
    next(error);
  }
});

io.on('connection', async (socket) => {
  socket.emit('dashboard:update', await getDashboardData());
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ message: 'Server error', detail: error.message });
});

cron.schedule('0 18 * * 5', async () => {
  try {
    const weekStart = startOfWeek();
    const weekEnd = endOfWeek();
    const teachers = await Teacher.find().lean();

    for (const teacher of teachers) {
      const records = await Attendance.find({ teacher: teacher._id, entryAt: { $gte: weekStart, $lt: weekEnd } }).lean();
      const totalMinutes = records.reduce((sum, record) => sum + (record.durationMinutes || 0), 0);
      const totalHours = Math.round((totalMinutes / 60) * 100) / 100;
      if (totalHours < MIN_WEEKLY_HOURS) {
        const exists = await Notification.findOne({ teacher: teacher._id, type: 'LOW_WEEKLY_HOURS', weekStart });
        if (!exists) await sendAdminAlert({ teacher, totalHours }, weekStart, weekEnd);
      }
    }

    await emitDashboard();
  } catch (error) {
    console.error('Weekly alert failed:', error);
  }
});

await mongoose.connect(MONGO_URI);
await seedDatabase();
server.listen(PORT, () => {
  console.log(`Attendance parking API running on http://localhost:${PORT}`);
});
